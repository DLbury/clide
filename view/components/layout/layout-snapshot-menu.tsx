'use client'

import { Save, Trash2 } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ServerLayoutSnapshot } from '@/lib/layout-snapshots'

interface LayoutSnapshotSaveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  onNameChange: (name: string) => void
  onConfirm: () => void
}

export function LayoutSnapshotSaveDialog({
  open,
  onOpenChange,
  name,
  onNameChange,
  onConfirm,
}: LayoutSnapshotSaveDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>保存布局快照</DialogTitle>
        </DialogHeader>
        <Input
          value={name}
          onChange={e => onNameChange(e.target.value)}
          placeholder="例如：开发四窗格"
          onKeyDown={e => {
            if (e.key === 'Enter') onConfirm()
          }}
          autoFocus
        />
          <p className="text-xs text-muted-foreground">
            保存分屏、各 Shell/浏览器/编辑器标签、每个终端当前路径及文件树位置；同一服务器可保存多套。
          </p>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={onConfirm} disabled={!name.trim()}>
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface LayoutSnapshotDropdownItemsProps {
  snapshots: ServerLayoutSnapshot[]
  canSave: boolean
  onSaveClick: () => void
  onLoad: (snapshot: ServerLayoutSnapshot) => void
  onDelete: (snapshotId: string) => void
}

/** 嵌入服务器「…」下拉菜单的布局快照项 */
export function LayoutSnapshotDropdownItems({
  snapshots,
  canSave,
  onSaveClick,
  onLoad,
  onDelete,
}: LayoutSnapshotDropdownItemsProps) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
        布局快照
      </DropdownMenuLabel>
      <DropdownMenuItem onClick={onSaveClick} disabled={!canSave}>
        <Save className="mr-2 h-4 w-4" />
        保存当前布局…
      </DropdownMenuItem>
      {snapshots.length === 0 && (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无已保存布局</div>
      )}
      {snapshots.map(s => (
        <DropdownMenuItem
          key={s.id}
          className="flex items-center justify-between gap-2"
          onSelect={e => {
            e.preventDefault()
            onLoad(s)
          }}
        >
          <span className="min-w-0 flex-1 truncate">{s.name}</span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="删除"
            onClick={e => {
              e.stopPropagation()
              e.preventDefault()
              onDelete(s.id)
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuItem>
      ))}
    </>
  )
}
