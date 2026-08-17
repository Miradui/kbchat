import { Check, Command, Eye, EyeOff } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { login } from '../../api/resources';
import { Button } from '../../components/ui/Button';
import { Field, Input } from '../../components/ui/Field';
import { IconButton } from '../../components/ui/IconButton';
import { tokenStore } from '../../store/tokenStore';
import { getErrorMessage } from '../../utils/errors';
import { DEFAULT_MAX_PASSWORD_BYTES, passwordUTF8ByteLength } from '../../utils/password';

type LoginPageProps = {
  loginRequest?: typeof login;
};

const points = [
  '知识库与文档集中管理',
  '检索与问答过程清晰可见',
  '每个回答都能追溯到来源',
];

export function LoginPage({ loginRequest = login }: LoginPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const usernameId = useId();
  const passwordId = useId();
  const passwordMessageId = useId();
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

  // A failed login must move focus to the message, not leave it on the button.
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;

    const passwordError = password.length === 0
      ? '请输入密码'
      : passwordUTF8ByteLength(password) > DEFAULT_MAX_PASSWORD_BYTES
        ? `密码不能超过 ${DEFAULT_MAX_PASSWORD_BYTES} 个 UTF-8 字节`
        : undefined;
    const nextFieldErrors = {
      username: username.trim() ? undefined : '请输入用户名',
      password: passwordError,
    };
    if (nextFieldErrors.username || nextFieldErrors.password) {
      setFieldErrors(nextFieldErrors);
      (nextFieldErrors.username ? usernameRef : passwordRef).current?.focus();
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
    <section className="auth">
      <aside className="auth__aside">
        <div className="auth__brand">
          <span className="auth__mark" aria-hidden="true"><Command /></span>
          <strong>RAG Console</strong>
        </div>
        <h2>让企业知识可检索、可问答、可追溯</h2>
        <p>统一管理知识库与文档处理流程，让每个回答都有清晰依据。</p>
        <ul className="auth__points">
          {points.map((point) => (
            <li key={point}><Check aria-hidden="true" /><span>{point}</span></li>
          ))}
        </ul>
      </aside>

      <div className="auth__panel">
        <form className="auth__form" noValidate onSubmit={handleSubmit}>
          <header>
            <h1>登录</h1>
            <p>使用已配置的账户进入工作台。</p>
          </header>

          <Field error={fieldErrors.username} htmlFor={usernameId} label="用户名">
            <Input
              aria-invalid={Boolean(fieldErrors.username)}
              autoComplete="username"
              disabled={submitting}
              id={usernameId}
              onChange={(event) => {
                setUsername(event.target.value);
                setFieldErrors((current) => ({ ...current, username: undefined }));
              }}
              ref={usernameRef}
              required
              value={username}
            />
          </Field>

          <Field
            error={fieldErrors.password}
            htmlFor={passwordId}
            label="密码"
            messageId={passwordMessageId}
          >
            <div className="auth__password">
              <Input
                aria-describedby={fieldErrors.password ? passwordMessageId : undefined}
                aria-invalid={Boolean(fieldErrors.password)}
                autoComplete="current-password"
                disabled={submitting}
                id={passwordId}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setFieldErrors((current) => ({ ...current, password: undefined }));
                }}
                ref={passwordRef}
                required
                type={showPassword ? 'text' : 'password'}
                value={password}
              />
              <IconButton
                disabled={submitting}
                label={showPassword ? '隐藏密码' : '显示密码'}
                onClick={() => setShowPassword((visible) => !visible)}
              >
                {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </IconButton>
            </div>
          </Field>

          {error && <p className="auth__error" ref={errorRef} role="alert" tabIndex={-1}>{error}</p>}

          <Button className="auth__submit" loading={submitting} loadingLabel="登录中" type="submit">登录</Button>
        </form>
      </div>
    </section>
  );
}

/** Only same-origin paths without control characters are accepted as a return target. */
function safeReturnPath(state: unknown): string {
  if (!state || typeof state !== 'object' || !('from' in state)) return '/home';
  const from = (state as { from?: unknown }).from;
  if (typeof from !== 'string' || !from.startsWith('/') || hasUnsafeCharacters(from)) {
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

function hasUnsafeCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // 0x5c is a backslash, which some browsers normalise into a path separator.
    if (code === 0x5c || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
