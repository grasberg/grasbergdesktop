import { useState } from 'react'
import { navigateGuarded } from './useUnsavedChanges'

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

  const openAdd = (): void => navigateGuarded(() => {
    setEditing(null)
    setFormOpen(true)
  }, 'settings')
  const openEdit = (item: T): void => navigateGuarded(() => {
    setEditing(item)
    setFormOpen(true)
  }, 'settings')
  const closeForm = (): void => {
    setFormOpen(false)
    setEditing(null)
  }

  return { formOpen, editing, openAdd, openEdit, closeForm }
}
