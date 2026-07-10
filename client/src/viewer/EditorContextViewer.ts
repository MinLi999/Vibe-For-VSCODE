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

import { type DocumentContext } from '../models/VocabularyModel';

export interface EditorSnapshot {
  documents: DocumentContext[];
  fileNames: string[];
  activeDocumentKey?: string;
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

  /** Snapshot of all currently opened text documents + recent filenames. */
  async snapshot(): Promise<EditorSnapshot> {
    let fileNames: string[] = [];
    try {
      const uris = await vscode.workspace.findFiles('**/*', FIND_EXCLUDE, RECENT_FILE_LIMIT);
      fileNames = uris.map((uri) => uri.path.split('/').pop() ?? '');
    } catch {
      // findFiles can throw with no workspace open (single-file window); the filename hint is
      // an enhancement, so degrade silently.
    }

    const documents = vscode.workspace.textDocuments
      .filter((doc) => {
        const scheme = doc.uri.scheme;
        return (scheme === 'file' || scheme === 'untitled' || scheme === 'vscode-remote') && !doc.isClosed;
      })
      .map((doc) => ({
        text: doc.getText(),
        key: `${doc.uri.toString()}@${doc.version}`,
      }));

    const activeDocumentKey = this.lastRealEditor
      ? `${this.lastRealEditor.document.uri.toString()}@${this.lastRealEditor.document.version}`
      : undefined;

    return { documents, fileNames, activeDocumentKey };
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
