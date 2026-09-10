import { Check, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createLowlight } from 'lowlight';
import type { RootContent } from 'hast';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

import { IconButton } from '../../components/ui/IconButton';
import { copyText } from '../../utils/clipboard';

const highlighter = createLowlight({ bash, css, go, javascript, json, python, sql, typescript, xml, yaml });

function tokensToReact(nodes: RootContent[]): ReactNode[] {
  return nodes.map((node, index) => node.type === 'text' ? node.value : node.type === 'element'
    ? <span className={(node.properties.className as string[] | undefined)?.join(' ')} key={index}>{tokensToReact(node.children)}</span>
    : null);
}

export function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlighted = useMemo(() => {
    if (!language || !highlighter.registered(language) || code.length > 50_000) return code;
    try {
      return tokensToReact(highlighter.highlight(language, code).children);
    } catch {
      return code;
    }
  }, [code, language]);

  useEffect(() => {
    setCopied(false);
    setFailed(false);
    return () => { if (timeout.current) clearTimeout(timeout.current); };
  }, [code]);

  async function copy() {
    try {
      await copyText(code);
      setCopied(true);
      setFailed(false);
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      setFailed(true);
    }
  }

  return (
    <figure aria-label={language ? `${language} 代码块` : '代码块'} className="chat-code">
      <figcaption>
        <span>{language || '代码'}</span>
        <IconButton label={copied ? '代码已复制' : '复制代码'} onClick={() => void copy()}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </IconButton>
      </figcaption>
      <pre tabIndex={0}><code>{highlighted}</code></pre>
      {failed && <p className="chat-code__error" role="alert">复制失败，请选择代码后手动复制。</p>}
    </figure>
  );
}
