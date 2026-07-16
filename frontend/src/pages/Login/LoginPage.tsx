import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

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
  const errorRef = useRef<HTMLParagraphElement>(null);
  const submittingRef = useRef(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setError('');
    setSubmitting(true);
    try {
      const response = await loginRequest(username, password);
      tokenStore.setToken(response.token);
      navigate('/home', { replace: true });
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
        <div><p className="eyebrow">RAG Console</p><h2>让企业知识可检索、可问答、可追溯</h2><p>统一管理知识库与文档处理流程，并通过真实 citations 追踪答案依据。</p></div>
        <ul><li>知识库与文档集中管理</li><li>检索、Rerank 与问答链路清晰可见</li><li>答案引用只来自实际进入 Prompt 的内容</li></ul>
      </aside>

      <form className="auth-panel" onSubmit={handleSubmit}>
        <header><p className="eyebrow">欢迎回来</p><h1>登录企业知识库</h1><p className="page-description">使用已配置的账户继续进入工作台。</p></header>
        <div className="auth-field"><label htmlFor="login-username">用户名</label><input autoComplete="username" disabled={submitting} id="login-username" required value={username} onChange={(event) => setUsername(event.target.value)} /></div>
        <div className="auth-field">
          <label htmlFor="login-password">密码</label>
          <div className="password-field">
            <input autoComplete="current-password" disabled={submitting} id="login-password" required type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} />
            <IconButton disabled={submitting} label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</IconButton>
          </div>
        </div>
        {error && <p className="auth-error" ref={errorRef} role="alert" tabIndex={-1}>{error}</p>}
        <Button className="auth-submit" loading={submitting} loadingLabel="登录中" type="submit">登录</Button>
      </form>
    </section>
  );
}
