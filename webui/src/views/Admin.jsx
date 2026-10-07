import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../stores/auth'
import { adminApi } from '../api'
import { toast } from '../utils/toast'
import { useResizable } from '../hooks/useResizable'
import { RzHandles } from '../components/RzHandles'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ArrowLeft, LogOut, Plus, Pencil, Trash2, Users } from 'lucide-react'

export default function Admin() {
  const navigate = useNavigate()
  const auth = useAuthStore()

  const [users, setUsers] = useState([])
  // 新增用户弹窗（表单在弹窗内填写；密码两次一致校验，错误就地提示）
  const [addModal, setAddModal] = useState(false)
  const [add, setAdd] = useState({ username: '', password: '', password2: '' })
  const [addErr, setAddErr] = useState('')
  const [editModal, setEditModal] = useState(false)
  const [edit, setEdit] = useState({ id: null, username: '', password: '' })
  const [editErr, setEditErr] = useState('')
  const { rzOn, rzStyle, rzStart, rzDragStart, rzReset } = useResizable()
  const { rzOn: addRzOn, rzStyle: addRzStyle, rzStart: addRzStart,
          rzDragStart: addRzDragStart, rzReset: addRzReset } = useResizable()

  async function load() {
    try {
      setUsers(await adminApi.users())
    } catch (e) {
      toast(e.message)
    }
  }

  useEffect(() => {
    if (!auth.isAdmin) { navigate('/app'); return }
    load()
  }, [])

  function openAdd() {
    setAdd({ username: '', password: '', password2: '' })
    setAddErr('')
    addRzReset()
    setAddModal(true)
  }

  async function addUser() {
    setAddErr('')
    if (add.password !== add.password2) { setAddErr('两次输入的密码不一致'); return }
    try {
      await adminApi.createUser({ username: add.username, password: add.password })
      setAddModal(false)
      toast('新增成功')
      await load()
    } catch (e) { setAddErr(e.message) }
  }

  function openEdit(u) {
    setEdit({ id: u.id, username: u.username, password: '' })
    setEditErr('')
    setEditModal(true)
  }

  async function saveEdit() {
    setEditErr('')
    try {
      const body = { username: edit.username }
      if (edit.password) body.password = edit.password
      await adminApi.updateUser(edit.id, body)
      setEditModal(false)
      await load()
    } catch (e) { setEditErr(e.message) }
  }

  async function delUser(u) {
    if (!window.confirm(`确认删除用户「${u.username}」？该操作不可恢复`)) return
    try {
      await adminApi.deleteUser(u.id)
      await load()
    } catch (e) { toast(e.message) }
  }

  async function logout() {
    await auth.logout()
    navigate('/login')
  }

  return (
    <div className="flex h-svh flex-col">
      <header className="flex flex-none items-center gap-3 border-b border-border bg-card px-6 py-3">
        <div className="flex items-center gap-2.5 font-semibold">
          <div className="ts-logo ts-mark size-6 rounded-md text-[calc(11px*var(--fs))]">
            TS
          </div>
          后台管理 · 用户
        </div>
        <span className="ml-auto text-sm text-muted-foreground">{auth.username}</span>
        <Button variant="ghost" size="sm" onClick={logout}>
          <LogOut /> 登出
        </Button>
      </header>

      {/* 左列（与设置页同款结构：导航位暂空，后续可放后台分区）+ 左下角固定「返回项目」入口 */}
      <div className="flex min-h-0 flex-1">
        <div className="sets-page-side">
          <div className="sets-page-nav" />
          <div className="sets-page-foot">
            <Button variant="ghost" size="sm" onClick={() => navigate('/app')}>
              <ArrowLeft /> 返回项目
            </Button>
          </div>
        </div>

        <main className="min-w-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* 用户列表 */}
          <Card className="gap-0 py-0">
            <CardHeader className="border-b border-border/60 px-5 py-4">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Users className="size-4 text-primary" /> 用户列表
                <span className="font-normal text-muted-foreground">{users.length} 人</span>
                <Button variant="outline" size="sm" className="ml-auto" onClick={openAdd}>
                  <Plus /> 新增用户
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="px-3 pb-3">
              {!users.length ? <div className="px-2 py-6 text-sm text-muted-foreground">暂无用户</div> : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="px-3">ID</TableHead>
                      <TableHead className="px-3">用户名</TableHead>
                      <TableHead className="px-3">创建时间</TableHead>
                      <TableHead className="px-3">角色</TableHead>
                      <TableHead className="px-3 text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell className="px-3 text-muted-foreground">{u.id}</TableCell>
                        <TableCell className="px-3 font-medium">{u.username}</TableCell>
                        <TableCell className="px-3 font-mono text-xs text-muted-foreground">{u.created_at}</TableCell>
                        <TableCell className="px-3">
                          {u.is_admin
                            ? <Badge variant="outline" className="border-[var(--admin-badge)] text-[var(--admin-badge)]">管理员</Badge>
                            : <Badge variant="secondary">普通用户</Badge>}
                        </TableCell>
                        <TableCell className="px-3">
                          <div className="flex justify-end gap-1.5">
                            <Button variant="ghost" size="sm" onClick={() => openEdit(u)}>
                              <Pencil /> 编辑
                            </Button>
                            {!u.is_admin && (
                              <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => delUser(u)}>
                                <Trash2 /> 删除
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </main>
      </div>

      {/* 新增用户弹窗: 表单在弹窗内填写(保留自定义拖拽, 与编辑弹窗同款) */}
      <Dialog open={addModal} onOpenChange={setAddModal}>
        <DialogContent
          className={'modal modal-rz' + (addRzOn ? ' rz-drag' : '')}
          style={{ ...addRzStyle, marginTop: 0 }}
          showCloseButton={false}
        >
          <RzHandles start={addRzStart} reset={addRzReset} />
          <DialogHeader className="text-left">
            <DialogTitle className="cursor-move select-none text-sm" onMouseDown={addRzDragStart}>新增用户</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label className="text-xs text-muted-foreground">用户名</Label>
              <Input value={add.username} onChange={(e) => { setAdd({ ...add, username: e.target.value.trim() }); setAddErr('') }}
                placeholder="2-32 位字母数字或 _ . -" />
            </div>
            <div className="grid grid-cols-[1fr_1fr] gap-3">
              <div className="grid gap-2">
                <Label className="text-xs text-muted-foreground">密码</Label>
                <Input value={add.password} onChange={(e) => setAdd({ ...add, password: e.target.value })}
                  type="password" placeholder="至少 6 位" />
              </div>
              <div className="grid gap-2">
                <Label className="text-xs text-muted-foreground">确认</Label>
                <Input value={add.password2} onChange={(e) => setAdd({ ...add, password2: e.target.value })}
                  type="password" placeholder="至少 6 位" />
              </div>
            </div>
            {addErr && <div className="text-sm text-destructive">{addErr}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddModal(false)}>取消</Button>
            <Button onClick={addUser}>新增用户</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑用户弹窗: 保留自定义拖拽 (modal/modal-rz + 8 方向手柄) */}
      <Dialog open={editModal} onOpenChange={setEditModal}>
        <DialogContent
          className={'modal modal-rz' + (rzOn ? ' rz-drag' : '')}
          style={{ ...rzStyle, marginTop: 0 }}
          showCloseButton={false}
        >
          <RzHandles start={rzStart} reset={rzReset} />
          <DialogHeader className="text-left">
            <DialogTitle className="cursor-move select-none text-sm" onMouseDown={rzDragStart}>编辑用户</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label className="text-xs text-muted-foreground">用户名</Label>
              <Input value={edit.username} onChange={(e) => { setEdit({ ...edit, username: e.target.value.trim() }); setEditErr('') }} />
            </div>
            <div className="grid gap-2">
              <Label className="text-xs text-muted-foreground">重置密码</Label>
              <Input value={edit.password} onChange={(e) => setEdit({ ...edit, password: e.target.value })} type="password" placeholder="留空则不修改" />
            </div>
            {editErr && <div className="text-sm text-destructive">{editErr}</div>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditModal(false)}>取消</Button>
            <Button onClick={saveEdit}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

