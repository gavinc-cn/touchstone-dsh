import { useState, useEffect } from 'react'
import { adminApi } from '../../api'
import { toast } from '../../utils/toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Brain, PlugZap, Trash2 } from 'lucide-react'

// RAG 语义检索配置面板（设置页「RAG 检索配置」分区，仅管理员可见）：读写 ~/.touchstone/rag.json。
// api_key 永不回显明文（服务端只回打码形态），输入框留空 = 保持现有 key 不变。
export default function RagPanel() {
  const [cfg, setCfg] = useState(null)      // 服务端回显（configured 状态 + 打码 key 信息）
  const [form, setForm] = useState({ api_base: '', model: '', api_key: '', timeout_s: '', batch_size: '' })
  const [test, setTest] = useState(null)    // 测试连接结果 {ok, dim? | error}
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const r = await adminApi.ragGet()
      setCfg(r)
      setForm({
        api_base: r.api_base || '',
        model: r.model || '',
        api_key: '',
        timeout_s: r.timeout_s != null ? String(r.timeout_s) : '',
        batch_size: r.batch_size != null ? String(r.batch_size) : '',
      })
    } catch (e) { toast(e.message) }
  }

  useEffect(() => { load() }, [])

  // 提交体组装：api_key/超时/批量留空则不下发该键（后端语义：api_key 缺省=保持现有值）
  function buildBody() {
    const body = { api_base: form.api_base.trim(), model: form.model.trim() }
    if (form.api_key) body.api_key = form.api_key
    if (form.timeout_s.trim()) body.timeout_s = form.timeout_s.trim()
    if (form.batch_size.trim()) body.batch_size = form.batch_size.trim()
    return body
  }

  async function save() {
    setBusy(true)
    try {
      await adminApi.ragSet(buildBody())
      toast('RAG 配置已保存，立即生效')
      await load()
    } catch (e) { toast(e.message) } finally { setBusy(false) }
  }

  // 测试连接：按表单当前值发一次单文本嵌入探测（key 留空时服务端用已存值），不落盘
  async function runTest() {
    setTest(null)
    setBusy(true)
    try { setTest(await adminApi.ragTest(buildBody())) }
    catch (e) { toast(e.message) } finally { setBusy(false) }
  }

  async function disableRag() {
    if (!window.confirm('确认停用 RAG 语义检索？将删除配置文件，检索回到纯词面模式')) return
    try {
      await adminApi.ragSet({ clear: true })
      toast('已停用 RAG')
      setTest(null)
      await load()
    } catch (e) { toast(e.message) }
  }

  return (
    <Card className="max-w-xl gap-4 py-4">
      <CardHeader className="px-5 pb-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Brain className="size-4 text-primary" /> 案例库语义检索（RAG）
          {cfg && (cfg.configured
            ? <Badge>已启用</Badge>
            : <Badge variant="secondary">未启用</Badge>)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        <div className="text-xs leading-relaxed text-muted-foreground">
          走 OpenAI 兼容 /v1/embeddings 接口做嵌入，与内置 BM25 混合检索案例库；
          未配置或调用失败时自动回落纯词面检索，不影响任务运行。保存后立即生效（无需重启）；
          更换模型后下次索引刷新自动全量重建。
        </div>
        <div className="truncate font-mono text-[calc(11px*var(--fs))] text-muted-foreground" title={cfg?.config_path || ''}>
          配置文件：{cfg?.config_path || '…'}
        </div>
        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground">API 地址（api_base，含 /v1，不含 /embeddings）</Label>
          <Input value={form.api_base} onChange={(e) => setForm({ ...form, api_base: e.target.value.trim() })}
            placeholder="https://api.openai.com/v1" />
        </div>
        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground">嵌入模型（model，非对话模型）</Label>
          <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value.trim() })}
            placeholder="text-embedding-3-small" />
        </div>
        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground">API Key（仅存服务端配置文件，不回显明文）</Label>
          <Input type="password" value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            placeholder={cfg?.has_api_key ? `已设置（${cfg.api_key_masked}，留空保持不变）` : 'sk-…'} />
        </div>
        <div className="grid grid-cols-[1fr_1fr] gap-3">
          <div className="grid gap-2">
            <Label className="text-xs text-muted-foreground">请求超时（秒）</Label>
            <Input value={form.timeout_s} onChange={(e) => setForm({ ...form, timeout_s: e.target.value.trim() })}
              placeholder={`默认 ${cfg?.timeout_s ?? 30}`} />
          </div>
          <div className="grid gap-2">
            <Label className="text-xs text-muted-foreground">嵌入批量大小</Label>
            <Input value={form.batch_size} onChange={(e) => setForm({ ...form, batch_size: e.target.value.trim() })}
              placeholder={`默认 ${cfg?.batch_size ?? 16}`} />
          </div>
        </div>
        {test && (test.ok
          ? <div className="text-sm text-[var(--ok-text)]">连接成功：嵌入向量维度 {test.dim}</div>
          : <div className="text-sm text-destructive">连接失败：{test.error}</div>)}
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={save}>保存配置</Button>
          <Button variant="ghost" disabled={busy} onClick={runTest}>
            <PlugZap /> 测试连接
          </Button>
          {cfg?.configured && (
            <Button variant="ghost" className="text-destructive hover:text-destructive" disabled={busy}
              onClick={disableRag}>
              <Trash2 /> 停用
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
