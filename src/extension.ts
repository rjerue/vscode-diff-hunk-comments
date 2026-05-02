import * as vscode from 'vscode';
import { diffLines } from 'diff';
import type { Change } from 'diff';

type ChangeKind = 'added' | 'removed' | 'modified';

interface DiffHunk {
  readonly filePath: string;
  readonly originalUri: string;
  readonly modifiedUri: string;
  readonly oldStartLine: number;
  readonly oldLineCount: number;
  readonly newStartLine: number;
  readonly newLineCount: number;
  readonly codeLensLine: number;
  readonly kind: ChangeKind;
  readonly diffText: string;
}

interface DiffLensArgs {
  readonly hunk: DiffHunk;
}

const batchStartMarker = '<!-- diff-hunk-comments:start -->';
const batchEndMarker = '<!-- diff-hunk-comments:end -->';

export function activate(context: vscode.ExtensionContext) {
  const provider = new DiffHunkCodeLensProvider();

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      provider,
    ),
    vscode.commands.registerCommand('diffHunkComments.commentHunk', async (args: DiffLensArgs) => {
      await commentOnHunk(args?.hunk);
    }),
    vscode.commands.registerCommand('diffHunkComments.commentActiveHunk', async () => {
      await commentOnActiveHunk();
    }),
    vscode.commands.registerCommand('diffHunkComments.copyActiveSelection', async () => {
      await copyActiveSelection();
    }),
    vscode.commands.registerCommand('diffHunkComments.refresh', () => {
      provider.refresh();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => provider.refresh()),
    vscode.window.tabGroups.onDidChangeTabs(() => provider.refresh()),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (isActiveModifiedDocument(event.document.uri)) {
        provider.refresh();
      }
    }),
  );
}

export function deactivate() {
  // Nothing to dispose outside context subscriptions.
}

class DiffHunkCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

  refresh() {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const diffInput = getActiveDiffInput();
    if (!diffInput || !sameUri(document.uri, diffInput.modified)) {
      return [];
    }

    if (!shouldShowForActiveDiff()) {
      return [];
    }

    const originalDocument = await vscode.workspace.openTextDocument(diffInput.original);
    if (token.isCancellationRequested) {
      return [];
    }

    const hunks = computeDiffHunks(originalDocument.getText(), document.getText(), document, diffInput.original);

    return hunks.map(hunk => {
      const line = codeLensLineForHunk(document, hunk);
      const range = new vscode.Range(line, 0, line, 0);

      return new vscode.CodeLens(range, {
        title: `$(comment) Comment ${formatHunkTarget(hunk)}`,
        command: 'diffHunkComments.commentHunk',
        tooltip: `Copy an agent-ready comment payload for ${formatHunkTarget(hunk)}`,
        arguments: [{ hunk } satisfies DiffLensArgs],
      });
    });
  }
}

async function commentOnHunk(hunk: DiffHunk | undefined) {
  if (!hunk) {
    vscode.window.showWarningMessage('No diff hunk was provided.');
    return;
  }

  const config = vscode.workspace.getConfiguration('diffHunkComments');
  let comment = '';

  if (config.get<boolean>('promptForComment', true)) {
    const input = await vscode.window.showInputBox({
      title: 'Comment for agent',
      prompt: `Optional feedback for ${formatHunkTarget(hunk)}`,
      placeHolder: 'Example: Replace this with a smaller icon import.',
      ignoreFocusOut: true,
    });

    if (input === undefined) {
      return;
    }

    comment = input.trim();
  }

  const entry = formatHunkEntry(hunk, comment);
  await deliverPayload(entry);
}

async function commentOnActiveHunk() {
  const editor = vscode.window.activeTextEditor;
  const diffInput = getActiveDiffInput();

  if (!editor || !diffInput || !sameUri(editor.document.uri, diffInput.modified)) {
    vscode.window.showWarningMessage('Focus the modified side of a VS Code diff before commenting on the current hunk.');
    return;
  }

  if (!shouldShowForActiveDiff()) {
    vscode.window.showWarningMessage('Diff Hunk Comments is configured to only show on Git Tree Compare working-tree diffs.');
    return;
  }

  const originalDocument = await vscode.workspace.openTextDocument(diffInput.original);
  const hunks = computeDiffHunks(originalDocument.getText(), editor.document.getText(), editor.document, diffInput.original);
  const activeLine = editor.selection.active.line + 1;
  const hunk = findHunkForLine(hunks, activeLine) ?? await pickHunk(hunks);

  await commentOnHunk(hunk);
}

async function copyActiveSelection() {
  const editor = vscode.window.activeTextEditor;
  const diffInput = getActiveDiffInput();

  if (!editor || !diffInput || !sameUri(editor.document.uri, diffInput.modified)) {
    vscode.window.showWarningMessage('Open the modified side of a VS Code diff before copying a selection.');
    return;
  }

  const selectedText = editor.document.getText(editor.selection);
  if (!selectedText.trim()) {
    vscode.window.showWarningMessage('Select changed lines in the modified side of the diff first.');
    return;
  }

  const filePath = getDisplayPath(editor.document.uri);
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  const comment = await vscode.window.showInputBox({
    title: 'Comment for agent',
    prompt: 'Optional feedback to include with this selected range',
    ignoreFocusOut: true,
  });

  if (comment === undefined) {
    return;
  }

  const entry = [
    '## Diff Comment',
    '',
    `File: ${filePath}`,
    `Modified lines: ${formatLineRange(start, Math.max(1, end - start + 1))}`,
    '',
    'Selected code:',
    '```',
    selectedText,
    '```',
    '',
    'Comment:',
    comment.trim() || '(add feedback here)',
  ].join('\n');

  await deliverPayload(entry);
}

function findHunkForLine(hunks: DiffHunk[], line: number) {
  return hunks.find(hunk => {
    if (hunk.newLineCount === 0) {
      return line === hunk.newStartLine;
    }

    return line >= hunk.newStartLine && line <= hunk.newStartLine + hunk.newLineCount - 1;
  });
}

async function pickHunk(hunks: DiffHunk[]) {
  if (hunks.length === 0) {
    vscode.window.showWarningMessage('No diff hunks were found in the active diff.');
    return undefined;
  }

  if (hunks.length === 1) {
    return hunks[0];
  }

  const selected = await vscode.window.showQuickPick(
    hunks.map((hunk, index) => ({
      label: `${index + 1}. ${hunk.kind} ${hunk.filePath}`,
      description: `-${formatLineRange(hunk.oldStartLine, hunk.oldLineCount)} +${formatLineRange(hunk.newStartLine, hunk.newLineCount)}`,
      hunk,
    })),
    {
      title: 'Select diff hunk to comment on',
      placeHolder: 'Cursor is not inside a hunk, so choose one explicitly.',
      matchOnDescription: true,
    },
  );

  return selected?.hunk;
}

async function deliverPayload(payload: string) {
  const commandId = vscode.workspace.getConfiguration('diffHunkComments').get<string>('agentCommand', '').trim();

  if (commandId) {
    try {
      await vscode.commands.executeCommand(commandId, payload);
      vscode.window.showInformationMessage(`Sent diff comment to ${commandId}.`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showWarningMessage(`Could not send to ${commandId}; copied to clipboard instead. ${message}`);
    }
  }

  const clipboard = await vscode.env.clipboard.readText();
  const batch = appendToClipboardBatch(clipboard, payload);

  await vscode.env.clipboard.writeText(batch.text);
  vscode.window.showInformationMessage(
    batch.appended
      ? `Appended diff comment to clipboard batch (${batch.count} comments).`
      : 'Copied diff comment batch to clipboard.',
  );
}

function getActiveDiffInput(): vscode.TabInputTextDiff | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff ? input : undefined;
}

function isActiveModifiedDocument(uri: vscode.Uri) {
  const diffInput = getActiveDiffInput();
  return !!diffInput && sameUri(uri, diffInput.modified);
}

function shouldShowForActiveDiff() {
  const config = vscode.workspace.getConfiguration('diffHunkComments');
  if (config.get<boolean>('showOnAllDiffs', true)) {
    return true;
  }

  const label = vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? '';
  return label.includes('(Working Tree)');
}

function computeDiffHunks(
  originalText: string,
  modifiedText: string,
  modifiedDocument: vscode.TextDocument,
  originalUri: vscode.Uri,
): DiffHunk[] {
  const changes = diffLines(originalText, modifiedText);
  const hunks: DiffHunk[] = [];
  let lastFlushedRemoval: MutableHunk | undefined;
  let oldLine = 1;
  let newLine = 1;
  let pending: MutableHunk | undefined;

  const pushHunk = (hunk: MutableHunk) => {
    hunks.push({
      filePath: getDisplayPath(modifiedDocument.uri),
      originalUri: originalUri.toString(),
      modifiedUri: modifiedDocument.uri.toString(),
      oldStartLine: hunk.oldStartLine,
      oldLineCount: hunk.oldLineCount,
      newStartLine: hunk.newStartLine,
      newLineCount: hunk.newLineCount,
      codeLensLine: codeLensLineForPendingHunk(hunk),
      kind: hunkKind(hunk.oldLineCount, hunk.newLineCount),
      diffText: [
        `@@ -${formatLineRange(hunk.oldStartLine, hunk.oldLineCount)} +${formatLineRange(hunk.newStartLine, hunk.newLineCount)} @@`,
        ...hunk.diffLines,
      ].join('\n'),
    });
  };

  const flush = (options: { holdRemoval?: boolean } = {}) => {
    if (!pending) {
      return;
    }

    if (options.holdRemoval && pending.oldLineCount > 0 && pending.newLineCount === 0) {
      lastFlushedRemoval = pending;
      pending = undefined;
      return;
    }

    pushHunk(pending);

    pending = undefined;
  };

  const commitHeldRemoval = () => {
    if (!lastFlushedRemoval) {
      return;
    }

    pushHunk(lastFlushedRemoval);
    lastFlushedRemoval = undefined;
  };

  for (const change of changes) {
    const count = lineCount(change);

    if (!change.added && !change.removed) {
      flush();
      commitHeldRemoval();
      oldLine += count;
      newLine += count;
      continue;
    }

    if (change.added && lastFlushedRemoval) {
      const removal = lastFlushedRemoval;
      lastFlushedRemoval = undefined;
      pending = createMutableHunk(removal.oldStartLine, removal.newStartLine);
      pending.oldLineCount = removal.oldLineCount;
      pending.removedLines.push(...removal.removedLines);
      pending.diffLines.push(...removal.diffLines);
    } else if (change.removed && pending?.newLineCount) {
      flush();
    } else if (change.removed) {
      commitHeldRemoval();
    }

    pending ??= createMutableHunk(oldLine, newLine);

    if (change.removed) {
      const lines = linesForDiff(change);
      pending.oldLineCount += count;
      pending.removedLines.push(...lines);
      pending.diffLines.push(...lines.map(line => `-${line}`));
      oldLine += count;
      flush({ holdRemoval: true });
      continue;
    }

    if (change.added) {
      const lines = linesForDiff(change);
      pending.firstAddedLine ??= newLine;
      pending.newLineCount += count;
      pending.addedLines.push(...lines.map((line, index) => ({ lineNumber: newLine + index, text: line })));
      pending.diffLines.push(...lines.map(line => `+${line}`));
      newLine += count;
    }
  }

  flush();
  commitHeldRemoval();
  return hunks;
}

function createMutableHunk(oldStartLine: number, newStartLine: number): MutableHunk {
  return {
    oldStartLine,
    newStartLine,
    oldLineCount: 0,
    newLineCount: 0,
    firstAddedLine: undefined,
    addedLines: [],
    removedLines: [],
    diffLines: [],
  };
}

interface MutableHunk {
  oldStartLine: number;
  oldLineCount: number;
  newStartLine: number;
  newLineCount: number;
  firstAddedLine: number | undefined;
  addedLines: Array<{ lineNumber: number; text: string }>;
  removedLines: string[];
  diffLines: string[];
}

function codeLensLineForPendingHunk(hunk: MutableHunk) {
  if (hunk.addedLines.length === 0) {
    return hunk.newStartLine;
  }

  const removedComparableLines = new Set(hunk.removedLines.map(comparableLine));
  const meaningfulAddition = hunk.addedLines.find(line => !removedComparableLines.has(comparableLine(line.text)));

  return meaningfulAddition?.lineNumber ?? hunk.firstAddedLine ?? hunk.newStartLine;
}

function comparableLine(line: string) {
  return line.trim().replace(/,$/, '');
}

function lineCount(change: Change) {
  if (typeof change.count === 'number') {
    return change.count;
  }

  return linesForDiff(change).length;
}

function linesForDiff(change: Change) {
  const normalized = change.value.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (lines.at(-1) === '') {
    lines.pop();
  }

  return lines;
}

function hunkKind(oldLineCount: number, newLineCount: number): ChangeKind {
  if (oldLineCount === 0) {
    return 'added';
  }

  if (newLineCount === 0) {
    return 'removed';
  }

  return 'modified';
}

function codeLensLineForHunk(document: vscode.TextDocument, hunk: DiffHunk) {
  if (document.lineCount === 0) {
    return 0;
  }

  const preferred = hunk.codeLensLine - 1;
  return Math.max(0, Math.min(preferred, document.lineCount - 1));
}

function formatHunkEntry(hunk: DiffHunk, comment: string) {
  return [
    '## Diff Comment',
    '',
    `File: ${hunk.filePath}`,
    `Change: ${hunk.kind}`,
    `Original lines: ${formatLineRange(hunk.oldStartLine, hunk.oldLineCount)}`,
    `Modified lines: ${formatLineRange(hunk.newStartLine, hunk.newLineCount)}`,
    '',
    'Diff:',
    '```diff',
    hunk.diffText,
    '```',
    '',
    'Comment:',
    comment || '(add feedback here)',
  ].join('\n');
}

function formatHunkTarget(hunk: DiffHunk) {
  const oldRange = formatLineRange(hunk.oldStartLine, hunk.oldLineCount);
  const newRange = formatLineRange(hunk.newStartLine, hunk.newLineCount);

  if (hunk.kind === 'added') {
    return `added lines +${newRange}`;
  }

  if (hunk.kind === 'removed') {
    return `removed lines -${oldRange}`;
  }

  return `changed lines -${oldRange} / +${newRange}`;
}

function appendToClipboardBatch(clipboard: string, entry: string) {
  const existing = parseClipboardBatch(clipboard);

  if (!existing) {
    const text = [
      batchStartMarker,
      '# Agent Diff Comments',
      '',
      'Apply the following review comments to the referenced diff hunks.',
      '',
      entry,
      '',
      batchEndMarker,
    ].join('\n');

    return { text, appended: false, count: 1 };
  }

  const entries = [...existing.entries, entry];
  const text = [
    batchStartMarker,
    '# Agent Diff Comments',
    '',
    'Apply the following review comments to the referenced diff hunks.',
    '',
    entries.join('\n\n---\n\n'),
    '',
    batchEndMarker,
  ].join('\n');

  return { text, appended: true, count: entries.length };
}

function parseClipboardBatch(clipboard: string) {
  const start = clipboard.indexOf(batchStartMarker);
  const end = clipboard.indexOf(batchEndMarker);

  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }

  const bodyStart = start + batchStartMarker.length;
  const body = clipboard.slice(bodyStart, end).trim();
  const firstEntry = body.indexOf('## Diff Comment');

  if (firstEntry === -1) {
    return { entries: [] };
  }

  const entries = body
    .slice(firstEntry)
    .split(/\n---\n/g)
    .map(entry => entry.trim())
    .filter(Boolean);

  return { entries };
}

function formatLineRange(startLine: number, lineCount: number) {
  if (lineCount <= 0) {
    return `${startLine}`;
  }

  if (lineCount === 1) {
    return `${startLine}`;
  }

  return `${startLine}-${startLine + lineCount - 1}`;
}

function getDisplayPath(uri: vscode.Uri) {
  if (uri.scheme === 'file') {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const relativePath = vscode.workspace.asRelativePath(uri, false);

    if (workspaceFolder && (vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
      return `${workspaceFolder.name}/${relativePath}`;
    }

    return relativePath;
  }

  return uri.toString();
}

function sameUri(left: vscode.Uri, right: vscode.Uri) {
  return left.toString() === right.toString();
}
