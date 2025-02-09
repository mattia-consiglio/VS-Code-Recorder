import * as fs from 'node:fs'
import * as util from 'node:util'
import * as path from 'node:path'
import * as vscode from 'vscode'
import * as readline from 'node:readline'
import {
	getEditorFileName,
	escapeString,
	getEditorLanguage,
	notificationWithProgress,
	generateFileName,
	formatDisplayTime,
	getExportPath,
	logToOutput,
	formatSrtTime,
	getConfig,
	removeDoubleQuotes,
	unescapeString,
} from './utilities'
import { type File, ChangeType, type CSVRowBuilder, type Change, type Recording } from './types'
import { extContext, statusBarItem } from './extension'

export const commands = {
	openSettings: 'vs-code-recorder.openSettings',
	startRecording: 'vs-code-recorder.startRecording',
	stopRecording: 'vs-code-recorder.stopRecording',
}

export const recording: Recording = {
	isRecording: false,
	timer: 0,
	startDateTime: null,
	endDateTime: null,
	sequence: 0,
}

let intervalId: NodeJS.Timeout
const fileQueue: File[] = []

/**
 * Builds a CSV row with the given parameters.
 *
 * @param {CSVRowBuilder} sequence - The sequence number of the change.
 * @param {CSVRowBuilder} rangeOffset - The offset of the changed range.
 * @param {CSVRowBuilder} rangeLength - The length of the changed range.
 * @param {CSVRowBuilder} text - The text of the change.
 * @param {string} type - The type of the change (optional, defaults to 'content').
 * @return {string} A CSV row string with the provided information.
 */
export function buildCsvRow({
	sequence,
	rangeOffset,
	rangeLength,
	text,
	type = ChangeType.CONTENT,
}: CSVRowBuilder): string | undefined {
	if (!recording.startDateTime) {
		return
	}

	if (type === 'heading') {
		return 'Sequence,Time,File,RangeOffset,RangeLength,Text,Language,Type\n'
	}
	const time = new Date().getTime() - recording.startDateTime.getTime()
	return `${sequence},${time},"${getEditorFileName()}",${rangeOffset},${rangeLength},"${escapeString(
		text
	)}",${getEditorLanguage()},${type}\n`
}

/**
 * Checks if the current file being edited is within the configured export path.
 * This is used to determine if the current file should be recorded or not.
 *
 * @returns {boolean} `true` if the current file is within the export path, `false` otherwise.
 */
export function isCurrentFileExported(): boolean {
	const editor = vscode.window.activeTextEditor
	const filename = editor?.document.fileName.replaceAll('\\', '/')
	const exportPath = getExportPath()
	if (!editor || !filename || !exportPath) {
		return false
	}
	return filename.startsWith(exportPath)
}

const onChangeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
	if (!recording.isRecording) {
		return
	}

	if (isCurrentFileExported()) {
		return
	}
	const editor = vscode.window.activeTextEditor
	if (editor && event.document === editor.document) {
		for (const change of event.contentChanges) {
			recording.sequence++
			addToFileQueue(
				buildCsvRow({
					sequence: recording.sequence,
					rangeOffset: change.rangeOffset,
					rangeLength: change.rangeLength,
					text: change.text,
				})
			)
			appendToFile()
		}
	}
})

/**
 * Starts the recording process and initializes necessary variables.
 * @param context - The extension context.
 */
export async function startRecording(): Promise<void> {
	if (!vscode.window.activeTextEditor) {
		vscode.window.showErrorMessage(vscode.l10n.t('No active text editor'))
		logToOutput(vscode.l10n.t('No active text editor'), 'info')
		return
	}
	if (recording.isRecording) {
		notificationWithProgress(vscode.l10n.t('Already recording'))
		logToOutput(vscode.l10n.t('Already recording'), 'info')
		return
	}
	const exportPath = getExportPath()
	if (!exportPath) {
		return
	}
	recording.isRecording = true
	recording.timer = 0
	recording.startDateTime = new Date()
	recording.endDateTime = null
	recording.sequence = 0
	intervalId = setInterval(() => {
		recording.timer++
		updateStatusBarItem()
	}, 1000)
	notificationWithProgress(vscode.l10n.t('Recording started'))
	logToOutput(vscode.l10n.t('Recording started'), 'info')

	const editorText = vscode.window.activeTextEditor?.document.getText()

	recording.sequence++
	const fileName = generateFileName(recording.startDateTime)
	if (!fileName) {
		stopRecording(true)
		return
	}

	const csvRow = {
		sequence: recording.sequence,
		rangeOffset: 0,
		rangeLength: 0,
		text: editorText ?? '',
		type: ChangeType.TAB,
	}
	addToFileQueue(buildCsvRow({ ...csvRow, type: 'heading' }))
	addToFileQueue(buildCsvRow(csvRow))
	appendToFile()
	extContext.subscriptions.push(onChangeSubscription)
	updateStatusBarItem()
}

/**
 * Stops the recording process and finalizes the recording data.
 * @param context - The extension context.
 */
export function stopRecording(force = false): void {
	if (!recording.isRecording) {
		notificationWithProgress(vscode.l10n.t('Not recording'))
		return
	}
	recording.isRecording = false
	clearInterval(intervalId)
	recording.timer = 0
	const index = extContext.subscriptions.indexOf(onChangeSubscription)
	if (index !== -1) {
		extContext.subscriptions.splice(index, 1)
	}
	updateStatusBarItem()
	if (force) {
		notificationWithProgress(vscode.l10n.t('Recording cancelled'))
		logToOutput(vscode.l10n.t('Recording cancelled'), 'info')
		return
	}
	notificationWithProgress(vscode.l10n.t('Recording finished'))
	logToOutput(vscode.l10n.t('Recording finished'), 'info')
	recording.endDateTime = new Date()
	processCsvFile()
}

/**
 * Appends the provided text to the file at the specified file path.
 * @param filePath - The path to the file to append to.
 * @param text - The text to append to the file.
 * @returns A Promise that resolves when the file has been appended to.
 */
const appendFileUtil = util.promisify(fs.appendFile)

/**
 * Appends data from the file queue to the appropriate file in the workspace.
 */
export async function appendToFile(): Promise<void> {
	const exportPath = getExportPath()
	if (!exportPath) {
		stopRecording(true)
		return
	}

	while (fileQueue.length) {
		const filePath = path.join(exportPath, fileQueue[0].name)
		await addToFile(filePath, fileQueue[0].content)
	}
}

/**
 * Appends text to a file at the specified file path.
 * @param filePath - The path to the file.
 * @param text - The text to append.
 */
async function addToFile(filePath: string, text: string): Promise<void> {
	try {
		await appendFileUtil(filePath, text)
		fileQueue.shift()
	} catch (err) {
		console.error('Failed to append to file:', err)
	}
}

/**
 * Appends an SRT line to the file queue for the previous change.
 *
 * This function is responsible for generating the SRT format line for the previous change and adding it to the file queue.
 * It checks if the SRT export format is enabled, and if so, it generates the SRT line for the previous change and adds it to the file queue.
 *
 * @param processedChanges - An array of processed changes.
 * @param i - The index of the current change in the processedChanges array.
 * @param exportInSrt - A boolean indicating whether the SRT export format is enabled.
 */
function addToSRTFile(processedChanges: Change[], i: number, exportInSrt: boolean) {
	if (!exportInSrt) {
		return
	}
	if (i === 0) {
		return
	}
	addToFileQueue(
		addSrtLine(
			processedChanges[i - 1].sequence,
			processedChanges[i - 1].startTime,
			processedChanges[i - 1].endTime,
			JSON.stringify({
				text: processedChanges[i - 1].text,
				file: processedChanges[i - 1].file,
				language: processedChanges[i - 1].language,
			})
		),
		'srt',
		true
	)
}

/**
 * Returns the new text content based on the change type and the previous change.
 * @param type - The type of the change.
 * @param text - The text of the change.
 * @param previousChange - The previous change.
 * @param rangeOffset - The offset of the range.
 * @param rangeLength - The length of the range.
 */
function getNewTextContent(
	type: string,
	text: string,
	previousChange: Change | null,
	rangeOffset: number,
	rangeLength: number
): string {
	if (type === ChangeType.TAB) {
		return text
	}
	if (!previousChange) {
		return ''
	}
	return getUpdatedText(previousChange.text, rangeOffset, rangeLength, text)
}

/**
 * Processes a single CSV line and returns the processed change
 */
async function processCSVLine(line: string, previousChange: Change | null): Promise<Change | null> {
	const lineArr = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)

	if (Number.isNaN(Number.parseInt(lineArr[0]))) {
		return null
	}

	const time = Number.parseInt(lineArr[1])
	const file = removeDoubleQuotes(lineArr[2])
	const rangeOffset = Number.parseInt(lineArr[3])
	const rangeLength = Number.parseInt(lineArr[4])
	const text = unescapeString(removeDoubleQuotes(lineArr[5]))
	const language = lineArr[6]
	const type = lineArr[7]

	const newText = getNewTextContent(type, text, previousChange, rangeOffset, rangeLength)

	/**
	 * Skip exporting changes with the same values to the previous change.
	 */
	if (
		previousChange &&
		time === previousChange.startTime &&
		file === previousChange.file &&
		newText === previousChange.text &&
		language === previousChange.language
	) {
		return null
	}

	return {
		sequence: previousChange ? previousChange.sequence + 1 : 1,
		file,
		startTime: time,
		endTime: 0,
		language,
		text: newText,
	}
}

/**
 * Returns the updated text content based on the previous text, range offset, range length, and new text.
 * @param previousText - The previous text.
 * @param rangeOffset - The offset of the range.
 * @param rangeLength - The length of the range.
 * @param newText - The new text.
 */
function getUpdatedText(
	previousText: string,
	rangeOffset: number,
	rangeLength: number,
	newText: string
): string {
	const textArray = previousText.split('')
	textArray.splice(rangeOffset, rangeLength, newText)
	return textArray.join('')
}

/**
 * Processes the CSV file and generates the necessary output files.
 */
async function processCsvFile(): Promise<void> {
	if (!validateRecordingState()) {
		return
	}

	const exportFormats = getConfig().get<string[]>('export.exportFormats', [])
	if (exportFormats.length === 0) {
		logToOutput(vscode.l10n.t('No export formats specified'), 'info')
		vscode.window.showWarningMessage(vscode.l10n.t('No export formats specified'))
		return
	}

	const exportPath = getExportPath()
	if (!exportPath) {
		return
	}

	if (!recording.startDateTime) {
		return
	}

	const sourceFileName = generateFileName(recording.startDateTime)
	if (!sourceFileName) {
		return
	}

	const filePath = path.join(exportPath, `${sourceFileName}.csv`)
	const processedChanges: Change[] = []

	const rl = readline.createInterface({
		input: fs.createReadStream(filePath),
		crlfDelay: Number.POSITIVE_INFINITY,
	})

	for await (const line of rl) {
		const previousChange = processedChanges[processedChanges.length - 1]
		const change = await processCSVLine(line, previousChange)

		if (change) {
			if (previousChange) {
				previousChange.endTime = change.startTime
				if (exportFormats.includes('SRT')) {
					addToSRTFile(processedChanges, processedChanges.length, true)
				}
			}
			processedChanges.push(change)
		}
	}

	finalizeRecording(processedChanges, exportFormats)
	rl.close()
}

function validateRecordingState(): boolean {
	if (!vscode.workspace.workspaceFolders) {
		logToOutput(
			vscode.l10n.t(
				'No workspace folder found. To process the recording is needed a workspace folder'
			),
			'error'
		)
		return false
	}
	if (!recording.endDateTime || !recording.startDateTime) {
		logToOutput(vscode.l10n.t('Recording date time is not properly set'), 'error')
		return false
	}
	return true
}

function finalizeRecording(processedChanges: Change[], exportFormats: string[]): void {
	const lastChange = processedChanges[processedChanges.length - 1]
	if (lastChange && recording.endDateTime && recording.startDateTime) {
		lastChange.endTime = recording.endDateTime.getTime() - recording.startDateTime.getTime()
		if (exportFormats.includes('SRT')) {
			addToSRTFile(processedChanges, processedChanges.length, true)
		}
	}

	if (exportFormats.includes('JSON')) {
		addToFileQueue(JSON.stringify(processedChanges), 'json', true)
	}
	appendToFile()
}

/**
 * Adds a line to the SRT file format.
 * @param sequence - The sequence number of the change.
 * @param start - The start time of the change.
 * @param end - The end time of the change.
 * @param text - The text of the change.
 * @returns A string representing a line in the SRT file format.
 */
function addSrtLine(sequence: number, start: number, end: number, text: string): string {
	return `${sequence}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${text}\n\n`
}

/**
 * Adds content to the file queue.
 * @param content - The content to add.
 * @param fileExtension - The file extension (optional, defaults to 'csv').
 */
export function addToFileQueue(
	content: string | undefined,
	fileExtension = 'csv',
	isExport = false
): void {
	if (!content) {
		return
	}
	if (!recording.startDateTime) {
		return
	}
	const fileName = generateFileName(recording.startDateTime, isExport)
	if (!fileName) {
		return
	}
	fileQueue.push({
		name: `${fileName}.${fileExtension}`,
		content: content,
	})
}

/**
 * Updates the status bar item with the current recording status and time.
 */
export function updateStatusBarItem(): void {
	const editor = vscode.window.activeTextEditor
	if (!editor && !recording) {
		statusBarItem.hide()
		return
	}
	if (recording.isRecording) {
		if (getConfig().get('appearance.showTimer') === false) {
			statusBarItem.text = '$(debug-stop)'
			statusBarItem.tooltip = vscode.l10n.t('Current time: {0}', formatDisplayTime(recording.timer))
		}
		if (getConfig().get('appearance.showTimer') === true) {
			statusBarItem.text = `$(debug-stop) ${formatDisplayTime(recording.timer)}`
			statusBarItem.tooltip = vscode.l10n.t('Stop Recording')
		}
		statusBarItem.command = commands.stopRecording
	} else {
		if (getConfig().get('appearance.minimalMode') === true) {
			statusBarItem.text = '$(circle-large-filled)'
		} else {
			statusBarItem.text = `$(circle-large-filled) ${vscode.l10n.t('Start Recording')}`
		}
		statusBarItem.tooltip = vscode.l10n.t('Start Recording')
		statusBarItem.command = commands.startRecording
	}
	statusBarItem.show()
}
