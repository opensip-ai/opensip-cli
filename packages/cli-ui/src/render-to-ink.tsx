/**
 * renderToInk — the interactive (TTY) interpreter.
 *
 * Walks the same `ViewNode` tree as `renderToText` and returns an Ink
 * element, mapping each semantic `Tone` onto a `DEFAULT_THEME` token via
 * `useTheme()` so the theme stays the single source of color truth. The
 * visible text it produces is identical to `renderToText`'s output (the
 * cross-renderer equivalence tests assert `stripAnsi(ink) === text`); the
 * only thing Ink adds is color, weight, and dimming.
 */

import { Box, Text } from 'ink';
import React from 'react';

import { useTheme, type Theme } from './theme.js';

import type { HintItem, Span, ViewNode } from './view-model.js';

const SEPARATOR_WIDTH = 60;
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/** Map a semantic tone to a theme color token. `default` → no override. */
function toneColor(theme: Theme, tone: Span['tone']): string | undefined {
  switch (tone) {
    case 'brand': { return theme.brand;
    }
    case 'success': { return theme.success;
    }
    case 'error': { return theme.error;
    }
    case 'warning': { return theme.warning;
    }
    case 'info': { return theme.info;
    }
    case 'muted': { return theme.muted;
    }
    case 'default':
    case undefined: {
      return undefined;
    }
  }
}

function SpanText({ span }: { readonly span: Span }): React.ReactElement {
  const theme = useTheme();
  return <Text color={toneColor(theme, span.tone)} bold={span.bold}>{span.text}</Text>;
}

/** Render one hint, bolding any configured substrings (longest-first). */
function HintText({ item }: { readonly item: HintItem }): React.ReactElement {
  const bolds = item.bold ?? [];
  if (bolds.length === 0) return <Text>{item.text}</Text>;
  const escaped = [...bolds]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replaceAll(REGEX_META, String.raw`\$&`));
  const parts = item.text.split(new RegExp(`(${escaped.join('|')})`));
  const boldSet = new Set<string>(bolds);
  return (
    <Text>
      {parts.map((p, i) => (boldSet.has(p) ? <Text key={i} bold>{p}</Text> : <Text key={i}>{p}</Text>))}
    </Text>
  );
}

function NodeView({ node }: { readonly node: ViewNode }): React.ReactElement | null {
  switch (node.kind) {
    case 'line': {
      return (
        <Text dimColor={node.dim}>
          {node.spans.map((s, i) => <SpanText key={i} span={s} />)}
        </Text>
      );
    }
    case 'heading': {
      return <HeadingView text={node.text} tone={node.tone} />;
    }
    case 'keyValues': {
      return (
        <Box flexDirection="column">
          {node.pairs.map((p, i) => <Text key={i}>{p.label}: {p.value}</Text>)}
        </Box>
      );
    }
    case 'table': {
      return (
        <Box flexDirection="column">
          <Text>{node.columns.join('  ')}</Text>
          {node.rows.map((cells, r) => (
            <Text key={r}>
              {cells.map((c, ci) => (
                <Text key={ci}>{ci > 0 ? '  ' : ''}<SpanText span={c} /></Text>
              ))}
            </Text>
          ))}
        </Box>
      );
    }
    case 'hints': {
      return (
        <Box paddingLeft={2}>
          <Text dimColor>
            {node.items.map((h, i) => (
              <Text key={i}>{i > 0 ? ' | ' : ''}<HintText item={h} /></Text>
            ))}
          </Text>
        </Box>
      );
    }
    case 'separator': {
      return <Text dimColor>{'─'.repeat(SEPARATOR_WIDTH)}</Text>;
    }
    case 'spacer': {
      return <Text> </Text>;
    }
    case 'group': {
      return (
        <Box flexDirection="column" paddingLeft={node.indent ?? 0}>
          {node.children.map((c, i) => <NodeView key={i} node={c} />)}
        </Box>
      );
    }
  }
}

function HeadingView({ text, tone }: { readonly text: string; readonly tone?: Span['tone'] }): React.ReactElement {
  const theme = useTheme();
  return <Text bold color={toneColor(theme, tone)}>== {text} ==</Text>;
}

/** Render a view-model node to an Ink element. */
export function renderToInk(node: ViewNode): React.ReactElement {
  return <NodeView node={node} />;
}
