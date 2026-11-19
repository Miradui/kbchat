import { AlertTriangle } from 'lucide-react';
import { Component } from 'react';
import type { ReactNode } from 'react';

import { Button } from '../ui/Button';

export function RenderFailure({ onRetry, local = false }: { onRetry?: () => void; local?: boolean }) {
  return <section className="ui-panel ui-boundary" role="alert">
    <div className="ui-boundary__head">
      <AlertTriangle aria-hidden="true" />
      <h2>{local ? '这部分内容暂时无法显示' : '页面暂时无法显示'}</h2>
    </div>
    <p>请重试，或刷新页面重新加载。刷新会丢失尚未保存的输入。</p>
    <div className="ui-boundary__actions">
      {onRetry && <Button onClick={onRetry} variant="secondary">重试显示</Button>}
      <Button onClick={() => window.location.reload()} variant="secondary">刷新页面</Button>
      {!local && <a className="ui-button ui-button--ghost" href="/home">返回首页</a>}
    </div>
  </section>;
}

export class RenderBoundary extends Component<{
  children: ReactNode;
  resetKey?: unknown;
  local?: boolean;
}, { failed: boolean; resetKey: unknown }> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { resetKey: unknown }) {
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }

  render() {
    return this.state.failed
      ? <RenderFailure local={this.props.local} onRetry={() => this.setState({ failed: false })} />
      : this.props.children;
  }
}
