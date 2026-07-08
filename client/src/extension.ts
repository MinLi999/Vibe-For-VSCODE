/**
 * Composition root: instantiates M/V/C/S and wires them together. No other layer may `new` a
 * cross-layer object itself.
 */
import * as vscode from 'vscode';

import { AudioState } from './models/AudioState';
import { VocabularyModel } from './models/VocabularyModel';
import { StatusBarViewer } from './viewer/StatusBarViewer';
import { TextInserter } from './viewer/TextInserter';
import { EditorContextViewer } from './viewer/EditorContextViewer';
import { AudioRecorderService } from './services/AudioRecorderService';
import { CloudflareApiService } from './services/CloudflareApiService';
import { VibeController } from './controllers/VibeController';

export function activate(context: vscode.ExtensionContext): void {
  const audioState = new AudioState();
  const vocabulary = new VocabularyModel();

  const statusBar = new StatusBarViewer();
  const inserter = new TextInserter();
  const editorContext = new EditorContextViewer();

  const recorder = new AudioRecorderService();
  const api = new CloudflareApiService();

  const controller = new VibeController(
    context.secrets,
    audioState,
    vocabulary,
    statusBar,
    inserter,
    editorContext,
    recorder,
    api,
  );
  controller.registerCommands(context);

  context.subscriptions.push(statusBar, editorContext, controller);
}

export function deactivate(): void {
  // All cleanup goes through the Disposable chain in context.subscriptions.
}
