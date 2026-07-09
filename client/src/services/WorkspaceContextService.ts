import * as vscode from 'vscode';

const FIND_EXCLUDE = '**/{node_modules,dist,out,.git,bin,build,target,package-lock.json,yarn.lock,pnpm-lock.yaml}/**';
const FILE_GLOB = '**/*.{ts,js,py,go,c,cpp,h,java,cs,html,css,json,md,rs,kt,swift,rb,php}';
const MAX_SCAN_FILES = 300;
const IDENTIFIER_PATTERN = /[a-zA-Z_][a-zA-Z0-9_]{3,19}/g;

const STOP_WORDS = new Set([
  'this', 'that', 'then', 'else', 'true', 'false', 'null', 'undefined',
  'function', 'return', 'const', 'import', 'export', 'from', 'default',
  'async', 'await', 'class', 'interface', 'type', 'enum', 'extends',
  'implements', 'public', 'private', 'protected', 'static', 'readonly',
  'void', 'never', 'string', 'number', 'boolean', 'object', 'symbol',
  'while', 'break', 'continue', 'switch', 'case', 'throw', 'catch',
  'finally', 'typeof', 'instanceof', 'delete', 'yield', 'super', 'with',
  'self', 'none', 'elif', 'pass', 'lambda', 'print', 'range',
]);

export class WorkspaceContextService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly fileKeywords = new Map<string, Map<string, number>>();
  private topWorkspaceKeywords: string[] = [];
  private isScanning = false;

  constructor() {
    // Start background scan
    void this.scanWorkspace();

    // Listen for file saves to update keywords incrementally
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const scheme = doc.uri.scheme;
        if (scheme === 'file' || scheme === 'vscode-remote') {
          void this.updateFileKeywords(doc.uri, doc.getText());
        }
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) {
          this.fileKeywords.delete(uri.toString());
        }
        this.rebuildTopKeywords();
      })
    );
  }

  getWorkspaceKeywords(): string[] {
    return this.topWorkspaceKeywords;
  }

  private async scanWorkspace(): Promise<void> {
    if (this.isScanning) {
      return;
    }
    this.isScanning = true;

    try {
      const uris = await vscode.workspace.findFiles(FILE_GLOB, FIND_EXCLUDE, MAX_SCAN_FILES);
      const decoder = new TextDecoder('utf-8');

      // Scan files in parallel chunks of 10 to avoid overloading
      const chunkSize = 10;
      for (let i = 0; i < uris.length; i += chunkSize) {
        const chunk = uris.slice(i, i + chunkSize);
        await Promise.all(
          chunk.map(async (uri) => {
            try {
              const stat = await vscode.workspace.fs.stat(uri);
              // Skip files larger than 256KB to avoid memory/perf issues
              if (stat.size > 256 * 1024) {
                return;
              }
              const bytes = await vscode.workspace.fs.readFile(uri);
              const text = decoder.decode(bytes);
              this.parseAndCache(uri.toString(), text);
            } catch {
              // Ignore unreadable files
            }
          })
        );
      }

      this.rebuildTopKeywords();
    } catch {
      // Degrade silently if workspace findFiles fails
    } finally {
      this.isScanning = false;
    }
  }

  private async updateFileKeywords(uri: vscode.Uri, text: string): Promise<void> {
    // Skip large files
    if (text.length > 256 * 1024) {
      return;
    }
    this.parseAndCache(uri.toString(), text);
    this.rebuildTopKeywords();
  }

  private parseAndCache(uriKey: string, text: string): void {
    const freqs = new Map<string, number>();
    for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
      const token = match[0];
      if (STOP_WORDS.has(token.toLowerCase())) {
        continue;
      }
      freqs.set(token, (freqs.get(token) ?? 0) + 1);
    }
    this.fileKeywords.set(uriKey, freqs);
  }

  private rebuildTopKeywords(): void {
    const merged = new Map<string, number>();
    for (const freqs of this.fileKeywords.values()) {
      for (const [token, count] of freqs.entries()) {
        merged.set(token, (merged.get(token) ?? 0) + count);
      }
    }

    this.topWorkspaceKeywords = [...merged.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100)
      .map(([token]) => token);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
