import { useEffect, useState } from 'react';
import { listAdminActivities } from '../../api/resources';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Button } from '../../components/ui/Button';
import { Pagination } from '../../components/ui/Pagination';
import type { AdminActivityListResponse } from '../../types/api';
import { getErrorMessage } from '../../utils/errors';
import { formatDateTime } from '../../utils/format';
import { actionLabels } from '../Home/activityDisplay';

export function AdminActivities({ revision }: { revision: number }) {
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<AdminActivityListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void listAdminActivities({ page, pageSize: 20 }).then((value) => {
      if (active) setResult(value);
    }).catch((caught) => {
      if (active) setError(getErrorMessage(caught, '无法加载操作记录'));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, reload, revision]);
  return (
    <section aria-labelledby="admin-activities-title" className="ui-panel">
      <div className="ui-panel__head">
        <h2 id="admin-activities-title">操作记录</h2>
        <Button onClick={() => setReload((value) => value + 1)} variant="secondary">刷新操作记录</Button>
      </div>
      {error && <p className="ui-inline-error" role="alert">{error}</p>}
      {loading ? <LoadingSkeleton announce columns={4} rows={3} /> : !error && (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <caption className="sr-only">所有管理员的操作记录</caption>
            <thead><tr><th>时间</th><th>操作者</th><th>操作</th><th>对象</th></tr></thead>
            <tbody>{result?.items.map((item) => (
              <tr key={item.id}>
                <td data-label="时间">{formatDateTime(item.createdAt)}</td>
                <td data-label="操作者">{item.actor.displayName} <span className="ui-muted">（{item.actor.username}）</span></td>
                <td data-label="操作">{actionLabels[item.action] ?? '管理操作'}</td>
                <td data-label="对象">{item.resourceName}</td>
              </tr>
            ))}</tbody>
          </table>
          {!result?.items.length && <p className="ui-table__empty">暂无操作记录。</p>}
          <Pagination page={page} pageSize={20} total={result?.total ?? 0} onPageChange={setPage} />
        </div>
      )}
    </section>
  );
}
