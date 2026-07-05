import { useState } from 'react'

/**
 * Open/closed state for the add-or-edit form of a CRUD list tab: `openAdd`
 * opens the form empty, `openEdit(item)` opens it prefilled, `closeForm`
 * closes and clears it.
 */
export function useEditorState<T>(): {
  formOpen: boolean
  editing: T | null
  openAdd: () => void
  openEdit: (item: T) => void
  closeForm: () => void
} {
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<T | null>(null)

  const openAdd = (): void => {
    setEditing(null)
    setFormOpen(true)
  }
  const openEdit = (item: T): void => {
    setEditing(item)
    setFormOpen(true)
  }
  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  return { formOpen, editing, openAdd, openEdit, closeForm }
}
