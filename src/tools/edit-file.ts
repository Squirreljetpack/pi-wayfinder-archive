import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AnchorStateManager } from "../anchors/AnchorStateManager.js";
import {
	ANCHOR_DELIMITER,
	formatLineWithHash,
	splitAnchor,
	stripHashes,
} from "../anchors/line-hashing.js";
import {
	combineDiffs,
	createUnifiedDiff,
	type DiffDetails,
} from "../rendering/diff-output.js";
import {
	renderCodeLikeCall,
	renderDiffResult,
} from "../rendering/pi-renderers.js";
import { EditFileSchema } from "./schemas.js";

export interface EditOperation {
	edit_type: "replace" | "replace_range" | "insert_after" | "insert_before";
	anchor: string;
	end_anchor?: string;
	text: string;
}

interface ResolvedEdit {
	edit: EditOperation;
	start: number;
	end: number;
}

export interface EditFailureDetails {
	path?: string;
	anchor?: string;
	line?: number;
	fieldName?: string;
	currentContent?: string;
	requestedContent?: string;
	editIndex?: number;
	message: string;
}

class EditFileError extends Error {
	constructor(
		message: string,
		readonly failure: EditFailureDetails,
	) {
		super(message);
		this.name = "EditFileError";
	}
}

interface EditFileToolDetails {
	files: string[];
	diff: string;
	diffs: DiffDetails[];
	firstChangedLine?: number;
	failures?: EditFailureDetails[];
}

interface StagedFileEdit {
	path: string;
	absolutePath: string;
	nextLines: string[];
	nextContent: string;
	diff: DiffDetails;
	editCount: number;
}

function canonicalTargetKey(absolutePath: string): string {
	const resolvedPath = resolve(absolutePath);
	try {
		return realpathSync.native(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

function detectLineEnding(content: string): "\r\n" | "\n" {
	return content.match(/\r\n|\n/)?.[0] === "\r\n" ? "\r\n" : "\n";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason ?? new Error("edit_file aborted");
}

async function withFileMutationQueues<T>(
	canonicalTargetKeys: string[],
	fn: () => Promise<T>,
): Promise<T> {
	const uniqueKeys = Array.from(new Set(canonicalTargetKeys)).sort();

	const runWithQueue = async (index: number): Promise<T> => {
		if (index >= uniqueKeys.length) return fn();
		return withFileMutationQueue(uniqueKeys[index], () =>
			runWithQueue(index + 1),
		);
	};

	return runWithQueue(0);
}

function collapseWhitespace(content: string): string {
	return content.replace(/\s+/g, " ").trim();
}

/** Only small files get the "did you mean" content scan in error paths. */
const CONTENT_MATCH_SCAN_LIMIT = 1000;

/**
 * When an anchor fails to resolve, check whether the requested content exactly
 * matches a line in the file; if so, return a hint naming the correct anchor
 * token(s) for that line. Returns "" when there is no exact match.
 */
function didYouMeanHint(
	lines: string[],
	anchors: string[],
	content: string,
): string {
	if (lines.length > CONTENT_MATCH_SCAN_LIMIT) return "";
	const matches: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === content) matches.push(anchors[i]);
	}
	if (matches.length === 0) return "";
	if (matches.length === 1) return `; did you mean ${matches[0]}`;
	return `; did you mean one of ${matches.join(", ")}`;
}

export interface MultiLineReplacementValidation {
	isValid: boolean;
	start?: number;
	end?: number;
}

export function validateMultiLineReplacement(
	rawAnchor: string,
	anchors: string[],
	lines: string[],
): MultiLineReplacementValidation {
	const rawLines = rawAnchor.split(/\r?\n/);
	if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") {
		rawLines.pop();
	}
	const N = rawLines.length;
	if (N <= 1) {
		return { isValid: false };
	}

	const lineWayMarkers: (string | null)[] = rawLines.map((line) => {
		if (!line.includes(ANCHOR_DELIMITER)) return null;
		const { anchor } = splitAnchor(line);
		return /^[A-Z][a-zA-Z]*$/.test(anchor) ? anchor : null;
	});

	const hasWayMarkers = lineWayMarkers.every((m) => m !== null);
	const hasNoWayMarkers = lineWayMarkers.every((m) => m === null);

	if (!hasWayMarkers && !hasNoWayMarkers) {
		return { isValid: false };
	}

	const rawContentLines = hasWayMarkers
		? rawLines.map((line) => splitAnchor(line).content)
		: rawLines;

	const matchingStarts: number[] = [];
	for (let i = 0; i <= lines.length - N; i++) {
		let matches = true;
		for (let j = 0; j < N; j++) {
			const lineInFile = lines[i + j];
			const reqLine = rawContentLines[j];
			if (
				lineInFile !== reqLine &&
				collapseWhitespace(lineInFile) !== collapseWhitespace(reqLine)
			) {
				matches = false;
				break;
			}
		}
		if (matches) {
			matchingStarts.push(i);
		}
	}

	if (matchingStarts.length !== 1) {
		return { isValid: false };
	}

	const start = matchingStarts[0];
	const end = start + N - 1;

	if (hasWayMarkers) {
		for (let j = 0; j < N; j++) {
			if (anchors[start + j] !== lineWayMarkers[j]) {
				return { isValid: false };
			}
		}
	}

	return { isValid: true, start, end };
}

/** Split a raw anchor string into lines, dropping one trailing empty line. */
function splitAnchorLines(rawAnchor: string): string[] {
	const rawLines = rawAnchor.split(/\r?\n/);
	if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") {
		rawLines.pop();
	}
	return rawLines;
}

/**
 * Split a multi-line anchor into a single-line (anchor, end_anchor) pair for
 * the corrected tool call: the first line becomes the anchor and the last
 * line the end_anchor. Only blocks whose first and last lines both carry an
 * anchor delimiter are split; anything else is returned unchanged.
 */
function splitMultiLineAnchor(
	rawAnchor: string,
): { anchor: string; end_anchor?: string } {
	const rawLines = splitAnchorLines(rawAnchor);
	if (rawLines.length <= 1) return { anchor: rawAnchor };
	const first = rawLines[0];
	const last = rawLines[rawLines.length - 1];
	if (
		!first.includes(ANCHOR_DELIMITER) ||
		!last.includes(ANCHOR_DELIMITER)
	) {
		return { anchor: rawAnchor };
	}
	return { anchor: first, end_anchor: last };
}

/**
 * Resolve a raw anchored line to a line range [start, start].
 * Multi-line anchors return an error containing the correct tool call using end_anchor
 * if the multi-line input is a valid multi-line replacement.
 */
function resolveAnchor(
	rawAnchor: string | undefined,
	anchors: string[],
	lines: string[],
	fieldName = "anchor",
	editIndex?: number,
	filePath?: string,
	allFiles?: Array<{ path: string; edits: EditOperation[] }>,
	currentEdits?: EditOperation[],
): { start: number; end: number } {
	if (!rawAnchor) {
		throw new EditFileError(`${fieldName} is missing`, {
			fieldName,
			message: `${fieldName} is missing`,
		});
	}

	const rawLines = rawAnchor.split(/\r?\n/);
	if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") {
		rawLines.pop();
	}

	if (rawLines.length > 1) {
		if (fieldName === "end_anchor") {
			const message =
				"end_anchor must be a single-line anchor; use a single-line end_anchor to delimit the range end";
			throw new EditFileError(message, { fieldName, editIndex, message });
		}

		const validation = validateMultiLineReplacement(rawAnchor, anchors, lines);
		if (
			validation.isValid &&
			validation.start !== undefined &&
			validation.end !== undefined
		) {
			const startAnchor = formatLineWithHash(
				lines[validation.start],
				anchors[validation.start],
			);
			const endAnchor = formatLineWithHash(
				lines[validation.end],
				anchors[validation.end],
			);

			const targetPath = filePath ?? "file.txt";
			const filesStructure = allFiles ?? [
				{
					path: targetPath,
					edits: currentEdits ?? [
						{ edit_type: "replace", anchor: rawAnchor, text: "" },
					],
				},
			];

			const correctedFiles = filesStructure.map((file) => {
				const isTargetFile = file.path === targetPath;
				return {
					...file,
					edits: file.edits.map((e, idx) => {
						const isTargetEdit =
							isTargetFile && (editIndex === undefined || idx === editIndex);
						const text = e.text.length > 500 ? "<elided>" : e.text;
						if (isTargetEdit) {
							return {
								edit_type:
									e.edit_type === "replace_range" ? "replace_range" : "replace",
								anchor: startAnchor,
								end_anchor: endAnchor,
								text,
							};
						}
						// Normalize every other edit too, so the corrected call can be
						// re-sent verbatim: multi-line anchors become a single-line
						// anchor plus end_anchor (inserts keep only the first line).
						const split = splitMultiLineAnchor(e.anchor);
						const isInsert =
							e.edit_type === "insert_before" ||
							e.edit_type === "insert_after";
						const endAnchorLines = e.end_anchor
							? splitAnchorLines(e.end_anchor)
							: [];
						const normalizedEndAnchor =
							e.end_anchor === undefined
								? split.end_anchor
								: endAnchorLines.length > 1
									? endAnchorLines[0]
									: e.end_anchor;
						return {
							...e,
							anchor: split.anchor,
							end_anchor: isInsert ? e.end_anchor : normalizedEndAnchor,
							text,
						};
					}),
				};
			});

			const correctToolCall = { files: correctedFiles };
			const message = `multi-line anchors are not supported directly; use single-line anchor with end_anchor. Correct tool call:\n${JSON.stringify(correctToolCall, null, 2)}`;
			throw new EditFileError(message, {
				fieldName,
				editIndex,
				message,
			});
		} else {
			const message =
				"multi-line anchors are not supported directly; use a single-line anchor with end_anchor to delimit the range end";
			throw new EditFileError(message, {
				fieldName,
				editIndex,
				message,
			});
		}
	}

	if (!rawAnchor.includes(ANCHOR_DELIMITER)) {
		const message = `${fieldName} must be a raw anchored line in the form AnchorWord${ANCHOR_DELIMITER}exact line content`;
		throw new EditFileError(message, { fieldName, message });
	}

	const { anchor, content } = splitAnchor(rawLines[0]);
	const effectiveContent = stripHashes(content);
	if (!/^[A-Z][a-zA-Z]*$/.test(anchor)) {
		const message =
			`${fieldName} has invalid hash format ${JSON.stringify(anchor)}: ` +
			"the AnchorWord must be a hash token registered for this file " +
			"(e.g. WayA, WayB) copied from read_file / get_file_skeleton / " +
			"get_function output, not a made-up word" +
			didYouMeanHint(lines, anchors, effectiveContent);
		throw new EditFileError(message, {
			anchor,
			fieldName,
			requestedContent: effectiveContent,
			message,
		});
	}

	const index = anchors.indexOf(anchor);
	if (index === -1) {
		const message =
			`anchor not found; requested ${JSON.stringify(effectiveContent)}` +
			didYouMeanHint(lines, anchors, effectiveContent);
		throw new EditFileError(message, {
			anchor,
			fieldName,
			requestedContent: effectiveContent,
			message,
		});
	}

	if (
		lines[index] !== effectiveContent &&
		collapseWhitespace(lines[index]) !== collapseWhitespace(effectiveContent)
	) {
		const line = index + 1;
		const message =
			`anchor content mismatch at line ${line}; current ${JSON.stringify(lines[index])}, requested ${JSON.stringify(effectiveContent)}` +
			didYouMeanHint(lines, anchors, effectiveContent);
		throw new EditFileError(message, {
			anchor,
			line,
			fieldName,
			currentContent: lines[index],
			requestedContent: effectiveContent,
			editIndex,
			message,
		});
	}

	return { start: index, end: index };
}

export function applyAnchoredEdits(
	lines: string[],
	anchors: string[],
	edits: EditOperation[],
	filePath?: string,
	allFiles?: Array<{ path: string; edits: EditOperation[] }>,
): string[] {
	const resolved: ResolvedEdit[] = edits
		.map((edit, editIndex) => {
			const anchorRange = resolveAnchor(
				edit.anchor,
				anchors,
				lines,
				"anchor",
				editIndex,
				filePath,
				allFiles,
				edits,
			);
			let start = anchorRange.start;
			let end = anchorRange.end;
			if (edit.edit_type === "replace_range") {
				if (!edit.end_anchor)
					throw new Error("end_anchor is required for replace_range edits");
				end = resolveAnchor(
					edit.end_anchor,
					anchors,
					lines,
					"end_anchor",
					editIndex,
					filePath,
					allFiles,
					edits,
				).end;
			} else if (edit.edit_type === "replace" && edit.end_anchor) {
				end = resolveAnchor(
					edit.end_anchor,
					anchors,
					lines,
					"end_anchor",
					editIndex,
					filePath,
					allFiles,
					edits,
				).end;
			}
			if (end < start)
				throw new Error("end_anchor must not appear before anchor");
			return { edit, start, end };
		})
		.sort((a, b) => b.start - a.start);

	for (let i = 0; i < resolved.length - 1; i++) {
		const earlier = resolved[i + 1];
		const later = resolved[i];
		if (earlier.end >= later.start)
			throw new Error("overlapping edits are not allowed");
	}

	const next = [...lines];
	for (const { edit, start, end } of resolved) {
		const replacement = stripHashes(edit.text);
		const replacementLines =
			replacement === "" ? [] : replacement.split(/\r?\n/);

		if (edit.edit_type === "insert_after")
			next.splice(end + 1, 0, ...replacementLines);
		else if (edit.edit_type === "insert_before")
			next.splice(start, 0, ...replacementLines);
		else next.splice(start, end - start + 1, ...replacementLines);
	}

	return next;
}

export function registerEditFileTool(
	pi: ExtensionAPI,
	anchors: AnchorStateManager,
): void {
	pi.registerTool({
		name: "edit_file",
		label: "Edit File Anchored",
		description:
			"Apply batched multi-file edits using stable anchors returned by read_file or AST tools. This is the default way to edit existing source files. For simple content-based edits without anchors, use the native edit tool (available in additive/preferred mode).",
		promptSnippet:
			"Edit existing source files using stable anchors from read_file/get_function/get_file_skeleton.",
		promptGuidelines: [
			"edit_file with freshly-read anchors is the DEFAULT way to edit existing source files; prefer it over edit_lines.",
			"Use edit_file for source-code edits ONLY after reading anchors with read_file, get_function, or get_file_skeleton.",
			"For multi-line replacements, specify single-line anchor + end_anchor (multi-line anchor strings are not supported directly).",
			"For simple edits where anchors are not available, use the native edit tool (in additive/preferred mode) or edit_lines (in replacement mode).",
			"Use edit_lines only when you read the file immediately before the call and take the line numbers from that read; never guess line numbers.",
		],
		parameters: EditFileSchema,
		renderCall(args, theme) {
			const files = Array.isArray(args.files)
				? args.files
						.map((file) => file.path)
						.filter((path): path is string => typeof path === "string")
				: [];
			return renderCodeLikeCall("edit_file", files, theme);
		},
		renderResult(result, options, theme, context) {
			return renderDiffResult(
				result as never,
				options,
				theme,
				context,
				"Editing",
			);
		},
		async execute(_id, params, signal, _onUpdate, ctx) {
			const fileTargets = params.files.map((file) => {
				const absolutePath = resolve(ctx.cwd, file.path.replace(/^@/, ""));
				return {
					file,
					absolutePath,
					canonicalKey: canonicalTargetKey(absolutePath),
				};
			});
			const seenPaths = new Set<string>();
			for (const { absolutePath, canonicalKey } of fileTargets) {
				if (seenPaths.has(canonicalKey))
					throw new Error(`duplicate edit_file target path: ${absolutePath}`);
				seenPaths.add(canonicalKey);
			}

			const staged: StagedFileEdit[] = [];

			await withFileMutationQueues(
				fileTargets.map((target) => target.canonicalKey),
				async () => {
					const failures: EditFailureDetails[] = [];

					for (const { file, absolutePath } of fileTargets) {
						throwIfAborted(signal);

						try {
							const content = await readFile(absolutePath, {
								encoding: "utf8",
								signal,
							});
							throwIfAborted(signal);

							const lineEnding = detectLineEnding(content);
							const lines = content.split(/\r?\n/);
							const currentAnchors = anchors.reconcile(absolutePath, lines);

							throwIfAborted(signal);
							const nextLines = applyAnchoredEdits(
								lines,
								currentAnchors,
								file.edits,
								file.path,
								params.files,
							);
							throwIfAborted(signal);
							const nextContent = nextLines.join(lineEnding);
							const diff = createUnifiedDiff(file.path, content, nextContent);

							staged.push({
								path: file.path,
								absolutePath,
								nextLines,
								nextContent,
								diff,
								editCount: file.edits.length,
							});
						} catch (error) {
							throwIfAborted(signal);
							const message =
								error instanceof Error ? error.message : String(error);
							const failure =
								error instanceof EditFileError ? error.failure : { message };
const indexLabel = failure.editIndex !== undefined ? ` edits[${failure.editIndex}]` : "";
							failures.push({
								...failure,
								path: file.path,
								message: `Failed ${file.path}${indexLabel}: ${message}`,
							});
						}
					}

if (failures.length > 0) {
						const error = new Error(
							failures.map((failure) => failure.message).join("\n"),
						);
						(error as Error & { details?: EditFileToolDetails; atomic: boolean }).details = {
							files: params.files.map((file) => file.path),
							diffs: [],
							diff: "",
							failures,
						};
						(error as Error & { atomic: boolean }).atomic = true;
						throw error;
					}

					for (const item of staged) {
						throwIfAborted(signal);
						await mkdir(dirname(item.absolutePath), { recursive: true });
						throwIfAborted(signal);
						await writeFile(item.absolutePath, item.nextContent, {
							encoding: "utf8",
							signal,
						});
						anchors.reconcile(item.absolutePath, item.nextLines);
					}
				},
			);

			const diffs = staged.map((item) => item.diff).filter((diff) => diff.diff);
			const summaries = staged.map(
				(item) => `Updated ${item.path}: ${item.editCount} anchored edit(s).`,
			);

			return {
				content: [{ type: "text", text: summaries.join("\n") }],
				details: {
					files: params.files.map((file) => file.path),
					diffs,
					diff: combineDiffs(diffs),
					firstChangedLine: diffs[0]?.firstChangedLine,
				} satisfies EditFileToolDetails,
			};
		},
	});
}
