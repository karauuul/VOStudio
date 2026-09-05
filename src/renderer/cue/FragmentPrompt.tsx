import { useState } from 'react'

interface Props {
  onSubmit: (text: string) => void
  onClose: () => void
}

export function FragmentPrompt({ onSubmit, onClose }: Props) {
  const [text, setText] = useState('')
  return (
    <div className="frag-pop">
      <input
        autoFocus
        value={text}
        placeholder="fragment text"
        onChange={(ev) => setText(ev.target.value)}
        onBlur={onClose}
        onKeyDown={(ev) => {
          ev.stopPropagation()
          if (ev.code === 'Enter' || ev.code === 'NumpadEnter') {
            ev.preventDefault()
            onSubmit(text)
            onClose()
          } else if (ev.code === 'Escape') {
            ev.preventDefault()
            onClose()
          }
        }}
      />
    </div>
  )
}
