import { CompletionResult, Completion, CompletionContext } from '@codemirror/autocomplete';
import { Diagnostic, setDiagnostics } from '@codemirror/lint';
import { Tooltip } from '@codemirror/tooltip';
import { PluginValue, EditorView, ViewUpdate } from '@codemirror/view';
import { CompletionTriggerKind, PublishDiagnosticsParams } from 'vscode-languageserver-protocol';
import { changesDelay, timeout } from './constants';
import { documentUri, languageId, workspace } from './facets';
import { CompletionItemKindMap, TextPosition } from './types';
import { posToOffset, formatContents, prefixMatch, mapCodemirrorSeverity } from './util';
import { Workspace } from './workspace';

export class LanguageServerPlugin implements PluginValue {
    private documentUri: string;
    private languageId: string;
    private workspace: Workspace;

    private documentVersion = 0;
    private changesTimeout = 0;

    constructor(private view: EditorView) {
        this.documentUri = this.view.state.facet(documentUri);
        this.languageId = this.view.state.facet(languageId);
        this.workspace = this.view.state.facet(workspace);
    }

    update({ docChanged }: ViewUpdate): void {
        if (!docChanged) return;
        if (this.changesTimeout) clearTimeout(this.changesTimeout);
        this.changesTimeout = self.setTimeout(() => {
            void this.sendChange({
                documentText: this.view.state.doc.toString(),
            });
        }, changesDelay);
    }

    destroy(): void {
        // TODO : destroy file handle
    }

    async sendChange({ documentText }: { documentText: string }): Promise<void> {
        try {
            await this.workspace.lspClient.notify('textDocument/didChange', {
                textDocument: {
                    uri: this.documentUri,
                    version: this.documentVersion++,
                },
                contentChanges: [{ text: documentText }],
            });
        } catch (e) {
            console.error(e);
        }
    }

    async requestDiagnostics(view: EditorView): Promise<void> {
        await this.sendChange({ documentText: view.state.doc.toString() });
    }

    async requestHoverTooltip(
        view: EditorView,
        { line, character }: TextPosition
    ): Promise<Tooltip | null> {
        if (!this.workspace.capabilities.hoverProvider) return null;

        await this.sendChange({ documentText: view.state.doc.toString() });
        const result = await this.workspace.lspClient.request('textDocument/hover', {
            textDocument: { uri: this.documentUri },
            position: { line, character },
        }, timeout);
        if (!result) return null;
        const { contents, range } = result;
        let pos = posToOffset(view.state.doc, { line, character });
        let end: number | undefined;
        if (range) {
            pos = posToOffset(view.state.doc, range.start);
            end = posToOffset(view.state.doc, range.end);
        }
        if (pos === null) return null;
        const dom = document.createElement('div');
        dom.classList.add('documentation');
        dom.textContent = formatContents(contents);
        return { pos, end, create: () => ({ dom }), above: true };
    }

    async requestCompletion(
        context: CompletionContext,
        { line, character }: TextPosition,
        {
            triggerKind,
            triggerCharacter,
        }: {
            triggerKind: CompletionTriggerKind;
            triggerCharacter: string | undefined;
        }
    ): Promise<CompletionResult | null> {
        if (!this.workspace.capabilities.completionProvider) return null;

        await this.sendChange({
            documentText: context.state.doc.toString(),
        });

        const result = await this.workspace.lspClient.request('textDocument/completion', {
            textDocument: { uri: this.documentUri },
            position: { line, character },
            context: {
                triggerKind,
                triggerCharacter,
            },
        }, timeout);

        if (!result) return null;

        const items = 'items' in result ? result.items : result;

        let options = items.map(
            ({
                detail,
                label,
                kind,
                textEdit,
                documentation,
                sortText,
                filterText,
            }) => {
                const completion: Completion & {
                    filterText: string;
                    sortText?: string;
                    apply: string;
                } = {
                    label,
                    detail,
                    apply: textEdit?.newText ?? label,
                    type: kind && CompletionItemKindMap[kind].toLowerCase(),
                    sortText: sortText ?? label,
                    filterText: filterText ?? label,
                };
                if (documentation) {
                    completion.info = formatContents(documentation);
                }
                return completion;
            }
        );

        const [, match] = prefixMatch(options);
        const token = context.matchBefore(match);
        let { pos } = context;

        if (token) {
            pos = token.from;
            const word = token.text.toLowerCase();
            if (/^\w+$/.test(word)) {
                options = options
                    .filter(({ filterText }) =>
                        filterText.toLowerCase().startsWith(word)
                    )
                    .sort(({ apply: a }, { apply: b }) => {
                        switch (true) {
                            case a.startsWith(token.text) &&
                                !b.startsWith(token.text):
                                return -1;
                            case !a.startsWith(token.text) &&
                                b.startsWith(token.text):
                                return 1;
                        }
                        return 0;
                    });
            }
        }
        return {
            from: pos,
            options,
        };
    }

    

    processDiagnostics(params: PublishDiagnosticsParams): void {
        const diagnostics = params.diagnostics
            .map<Diagnostic>(({ range, message, severity }) => ({
                from: posToOffset(this.view.state.doc, range.start),
                to: posToOffset(this.view.state.doc, range.end),
                severity: mapCodemirrorSeverity(severity),
                message,
            }))
            .filter(({ from, to }) => from !== null && to !== null && from !== undefined && to !== undefined)
            .sort((a, b) => {
                switch (true) {
                    case a.from < b.from:
                        return -1;
                    case a.from > b.from:
                        return 1;
                }
                return 0;
            });

        this.view.dispatch(setDiagnostics(this.view.state, diagnostics));
    }
}
