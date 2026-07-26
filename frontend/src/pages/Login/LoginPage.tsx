import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { login } from '../../api/resources';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';
import { tokenStore } from '../../store/tokenStore';
import { getErrorMessage } from '../../utils/errors';

type LoginPageProps = {
  loginRequest?: typeof login;
};

export function LoginPage({ loginRequest = login }: LoginPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    const nextFieldErrors = {
      username: username.trim() ? undefined : '请输入用户名',
      password: password.trim() ? undefined : '请输入密码',
    };
    if (nextFieldErrors.username || nextFieldErrors.password) {
      setFieldErrors(nextFieldErrors);
      if (nextFieldErrors.username) {
        usernameRef.current?.focus();
      } else {
        passwordRef.current?.focus();
      }
      return;
    }
    submittingRef.current = true;
    setFieldErrors({});
    setError('');
    setSubmitting(true);
    try {
      const response = await loginRequest(username.trim(), password);
      tokenStore.setToken(response.token);
      navigate(safeReturnPath(location.state), { replace: true });
    } catch (caught) {
      setError(getErrorMessage(caught, '登录失败，请稍后重试'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-page">
      <aside className="auth-context" aria-label="产品说明">
        <div><p className="eyebrow">RAG Console</p><h2>让企业知识可检索、可问答、可追溯</h2><p>统一管理知识库与文档处理流程，让每个回答都有清晰依据。</p></div>
        <ul><li>知识库与文档集中管理</li><li>检索与问答过程清晰可见</li><li>回答依据可查看、可追溯</li></ul>
      </aside>

      <form className="auth-panel" onSubmit={handleSubmit}>
        <header><p className="eyebrow">欢迎回来</p><h1>登录企业知识库</h1><p className="page-description">使用已配置的账户继续进入工作台。</p></header>
        <div className="auth-field">
          <label htmlFor="login-username">用户名</label>
          <input
            aria-describedby={fieldErrors.username ? 'login-username-error' : undefined}
            aria-invalid={Boolean(fieldErrors.username)}
            autoComplete="username"
            disabled={submitting}
            id="login-username"
            ref={usernameRef}
            required
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
              setFieldErrors((current) => ({ ...current, username: undefined }));
            }}
          />
          {fieldErrors.username && <p className="auth-field-error" id="login-username-error">{fieldErrors.username}</p>}
        </div>
        <div className="auth-field">
          <label htmlFor="login-password">密码</label>
          <div className="password-field">
            <input
              aria-describedby={fieldErrors.password ? 'login-password-error' : undefined}
              aria-invalid={Boolean(fieldErrors.password)}
              autoComplete="current-password"
              disabled={submitting}
              id="login-password"
              ref={passwordRef}
              required
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setFieldErrors((current) => ({ ...current, password: undefined }));
              }}
            />
            <IconButton disabled={submitting} label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</IconButton>
          </div>
          {fieldErrors.password && <p className="auth-field-error" id="login-password-error">{fieldErrors.password}</p>}
        </div>
        {error && <p className="auth-error" ref={errorRef} role="alert" tabIndex={-1}>{error}</p>}
        <Button className="auth-submit" loading={submitting} loadingLabel="登录中" type="submit">登录</Button>
      </form>
    </section>
  );
}

function safeReturnPath(state: unknown): string {
  if (!state || typeof state !== 'object' || !('from' in state)) {
    return '/home';
  }
  const from = (state as { from?: unknown }).from;
  if (typeof from !== 'string' || !from.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(from)) {
    return '/home';
  }
  try {
    const target = new URL(from, window.location.origin);
    return target.origin === window.location.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : '/home';
  } catch {
    return '/home';
  }
}
