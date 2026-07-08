/**
 * Viewer layer: read-only UI adapter — reads the active editor's raw text + recent workspace filenames.
 * Zero token logic (word frequency/top-40 lives in the Model layer); listens to onDidChangeActiveTextEditor
 * so context from the "last real file" is still available after focus moves to a chat panel/terminal.
 * Return shape is compatible with models/VocabularyModel's EditorContextInput, but does not import
 * the Model (no cross-layer references).
 */
import * as vscode from 'vscode';

const RECENT_FILE_LIMIT = 15;
const FIND_EXCLUDE = '**/{node_modules,dist,out,.git}/**';

export interface EditorSnapshot {
  documentText: string | null;
  documentKey: string | null;
  fileNames: string[];
}

export class EditorContextViewer implements vscode.Disposable {
  private lastRealEditor: vscode.TextEditor | undefined;
  private readonly listener: vscode.Disposable;

  constructor() {
    this.lastRealEditor = EditorContextViewer.realEditorOf(vscode.window.activeTextEditor);
    this.listener = vscode.window.onDidChangeActiveTextEditor((editor) => {
      const real = EditorContextViewer.realEditorOf(editor);
      if (real !== undefined) {
        this.lastRealEditor = real;
      }
    });
  }

  /** Snapshot of the current (or most recent) file editor + recent filenames. */
  async snapshot(): Promise<EditorSnapshot> {
    const editor = EditorContextViewer.realEditorOf(vscode.window.activeTextEditor) ?? this.lastRealEditor;
    const document = editor?.document;

    let fileNames: string[] = [];
    try {
      const uris = await vscode.workspace.findFiles('**/*', FIND_EXCLUDE, RECENT_FILE_LIMIT);
      fileNames = uris.map((uri) => uri.path.split('/').pop() ?? '');
    } catch {
      // findFiles can throw with no workspace open (single-file window); the filename hint is
      // an enhancement, so degrade silently.
    }

    if (document === undefined || document.isClosed) {
      return { documentText: null, documentKey: null, fileNames };
    }
    return {
      documentText: document.getText(),
      documentKey: `${document.uri.toString()}@${document.version}`,
      fileNames,
    };
  }

  dispose(): void {
    this.listener.dispose();
  }

  /** Filters out non-file editors like the output/debug console. */
  private static realEditorOf(editor: vscode.TextEditor | undefined): vscode.TextEditor | undefined {
    if (editor === undefined) {
      return undefined;
    }
    const scheme = editor.document.uri.scheme;
    return scheme === 'file' || scheme === 'untitled' || scheme === 'vscode-remote' ? editor : undefined;
  }
}
