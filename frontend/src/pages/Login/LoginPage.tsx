import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { ApiError } from '../../api/client';
import { login } from '../../api/resources';
import { tokenStore } from '../../store/tokenStore';

export function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const response = await login(username, password);
      tokenStore.setToken(response.token);
      navigate('/home', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('登录失败');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-page">
      <form className="auth-panel" onSubmit={handleSubmit}>
        <div>
          <p className="eyebrow">RAG Console</p>
          <h1>登录企业知识库</h1>
          <p className="page-description">进入知识库、文档处理与引用可追踪问答工作台。</p>
        </div>

        <label>
          用户名
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>

        <label>
          密码
          <input
            autoComplete="current-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>

        {error && <p className="error-text">{error}</p>}

        <button type="submit" disabled={submitting}>
          {submitting ? '登录中...' : '登录'}
        </button>
      </form>

      <aside className="auth-context" aria-label="产品说明">
        <div>
          <p className="eyebrow">工作台</p>
          <h2>连接资料、检索与问答</h2>
        </div>
        <p>
          上传 txt、md、pdf 文档后，系统会完成解析、切片和 embedding。问答结果会展示引用来源，
          方便追踪 filename、pageNumber、vectorScore 与 rerankScore。
        </p>
        <div className="auth-context-list">
          <div className="auth-context-item">
            <strong>知识库管理</strong>
            <span>创建、编辑并进入每个知识库的检索配置。</span>
          </div>
          <div className="auth-context-item">
            <strong>文档处理</strong>
            <span>查看上传、解析、切片、embedding 和失败原因。</span>
          </div>
          <div className="auth-context-item">
            <strong>引用可追踪问答</strong>
            <span>只展示后端返回的 citations，不隐藏来源。</span>
          </div>
        </div>
      </aside>
    </section>
  );
}
