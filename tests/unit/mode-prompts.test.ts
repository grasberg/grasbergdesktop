import { describe, expect, it } from 'vitest'
import { buildModeSystemPrompt } from '../../src/main/prompts'

describe('buildModeSystemPrompt', () => {
  it('chat mode adds conversational tone guidance but no artifact formats', () => {
    const prompt = buildModeSystemPrompt('chat')
    expect(prompt).toContain('Grasberg Desktop')
    expect(prompt).toContain('Chat mode')
    // Honesty-over-validation and formatting restraint (from tone guidance).
    expect(prompt).toContain('"You\'re absolutely right"')
    expect(prompt).toContain('at most one clarifying question')
    // Chat mode has no artifact block formats (and no memory by default).
    expect(prompt).not.toContain('uld-item')
    expect(prompt).not.toContain('uld-change')
    expect(prompt).not.toContain('uld-doc')
    expect(prompt).not.toContain('uld-html')
    expect(prompt).not.toContain('uld-memory')
  })

  it('cowork mode instructs the uld-item format with upsert-by-title semantics', () => {
    const prompt = buildModeSystemPrompt('cowork')
    expect(prompt).toContain('Cowork mode')
    expect(prompt).toContain('```uld-item')
    // The update-instead-of-duplicate rule (matches itemUpsertByKindTitle).
    expect(prompt).toContain('UPDATES that item')
    expect(prompt).toContain('"status":"todo|doing|done"')
    // Clarify-then-plan-then-verify workflow.
    expect(prompt).toContain('clarifying questions')
    expect(prompt).toContain('verification step')
  })

  it('code mode instructs the uld-change format and working practices', () => {
    const prompt = buildModeSystemPrompt('code')
    expect(prompt).toContain('```uld-change')
    // Read-before-propose, scope discipline, security, code references.
    expect(prompt).toContain('NEVER propose changes to code you have not read')
    expect(prompt).toContain('Avoid over-engineering')
    expect(prompt).toContain('security vulnerabilities')
    expect(prompt).toContain('file_path:line_number')
    expect(prompt).toContain('Never give time estimates')
    // Agent-style communication and task discipline.
    expect(prompt).toContain('Lead with the outcome')
    expect(prompt).toContain('the deliverable is your assessment')
    expect(prompt).toContain('When you have enough information to act, act')
    expect(prompt).toContain('match its comment density')
    // Honest verification framing: the app never runs project code.
    expect(prompt).toContain('you cannot run the project')
    // De-branded: no upstream product/model names.
    expect(prompt).not.toMatch(/claude/i)
    // Agentic tool guidance (grep/glob/git, edit_file/write_file, tasks, web).
    expect(prompt).toContain('grep (regex content search)')
    expect(prompt).toContain('edit_file and write_file tools are available, prefer them')
    expect(prompt).toContain('update_task_list')
    expect(prompt).toContain('web_search')
    expect(prompt).toContain('background=true')
    expect(prompt).toContain('ask_user_question')
  })

  it('code mode appends the plan-mode section only when planMode is set', () => {
    const planning = buildModeSystemPrompt('code', { planMode: true })
    expect(planning).toContain('PLAN MODE IS ACTIVE')
    expect(planning).toContain('do not call edit_file, write_file or run_shell_command')

    expect(buildModeSystemPrompt('code')).not.toContain('PLAN MODE IS ACTIVE')
    // Plan mode is a code-mode concept only.
    expect(buildModeSystemPrompt('chat', { planMode: true })).not.toContain('PLAN MODE IS ACTIVE')
  })

  it('design mode instructs the uld-html format and design approach', () => {
    const prompt = buildModeSystemPrompt('design')
    expect(prompt).toContain('```uld-html')
    // Aesthetic-direction guidance adapted to the sandboxed (offline) preview.
    expect(prompt).toContain('aesthetic direction')
    expect(prompt).toContain('External fonts cannot load in the sandboxed preview')
    expect(prompt).toContain('CSS variables')
    expect(prompt).toContain('AI-look tropes')
  })

  it('adds tool-usage guidance (untrusted results, sources) when tools are callable', () => {
    const prompt = buildModeSystemPrompt('cowork', {
      toolsAvailable: true,
      toolNames: ['fetch_url', 'browser'],
    })
    expect(prompt).toContain('fetch_url, browser')
    expect(prompt).toContain('untrusted DATA')
    expect(prompt).toContain('Sources:')
  })

  it('adds the fallback paragraph when tools exist but the model cannot call them', () => {
    const prompt = buildModeSystemPrompt('chat', {
      toolsAvailable: false,
      toolNames: ['fetch_url'],
    })
    expect(prompt).toContain('cannot call tools')
    expect(prompt).not.toContain('untrusted DATA')
  })

  it('adds neither tools section when there are no tools', () => {
    const prompt = buildModeSystemPrompt('chat', { toolsAvailable: true, toolNames: [] })
    expect(prompt).not.toContain('untrusted DATA')
    expect(prompt).not.toContain('cannot call tools')
  })

  it('adds the memory section with saved memories when enabled', () => {
    const prompt = buildModeSystemPrompt('chat', {
      memoryEnabled: true,
      memories: [
        { title: 'preferred-language', content: 'Prefers Swedish.' },
        { title: 'role', content: 'Backend developer at Acme.' },
      ],
    })
    expect(prompt).toContain('```uld-memory')
    expect(prompt).toContain('"action":"remember"')
    expect(prompt).toContain('"forget" deletes')
    expect(prompt).toContain('NEVER save secrets')
    expect(prompt).toContain('Saved memories (most recent first):')
    expect(prompt).toContain('- "preferred-language": Prefers Swedish.')
    expect(prompt).toContain('- "role": Backend developer at Acme.')
  })

  it('memory enabled with no memories still instructs the format', () => {
    const prompt = buildModeSystemPrompt('cowork', { memoryEnabled: true, memories: [] })
    expect(prompt).toContain('```uld-memory')
    expect(prompt).toContain('No memories are saved yet.')
    expect(prompt).not.toContain('Saved memories')
  })

  it('caps the listed memories at the character budget', () => {
    const memories = Array.from({ length: 100 }, (_, i) => ({
      title: `memory-${i}`,
      content: 'x'.repeat(200),
    }))
    const prompt = buildModeSystemPrompt('chat', { memoryEnabled: true, memories })
    expect(prompt).toContain('- "memory-0":')
    expect(prompt).toContain('- (older memories omitted)')
    expect(prompt).not.toContain('- "memory-99":')
  })

  it('omits all memory text in every mode when not enabled', () => {
    for (const mode of ['chat', 'cowork', 'code', 'write', 'design'] as const) {
      expect(buildModeSystemPrompt(mode)).not.toContain('uld-memory')
      expect(buildModeSystemPrompt(mode, { memoryEnabled: false })).not.toContain('uld-memory')
    }
  })

  it('lists skills with descriptions and points at use_skill when tools are callable', () => {
    const prompt = buildModeSystemPrompt('chat', {
      toolsAvailable: true,
      toolNames: ['use_skill'],
      skills: [
        { name: 'triage', description: 'Triage incoming issues.', content: 'FULL TRIAGE STEPS' },
      ],
    })
    expect(prompt).toContain('Installed skills')
    expect(prompt).toContain('- triage: Triage incoming issues.')
    expect(prompt).toContain('call the use_skill tool')
    // Progressive disclosure: full content is NOT inlined when tools work.
    expect(prompt).not.toContain('FULL TRIAGE STEPS')
  })

  it('inlines skill content (capped) when the model cannot call tools', () => {
    const prompt = buildModeSystemPrompt('chat', {
      toolsAvailable: false,
      toolNames: ['use_skill'],
      skills: [
        { name: 'triage', description: 'Triage incoming issues.', content: 'FULL TRIAGE STEPS' },
        { name: 'huge', description: 'Too big to inline.', content: 'y'.repeat(30_000) },
      ],
    })
    expect(prompt).toContain('### Skill: triage')
    expect(prompt).toContain('FULL TRIAGE STEPS')
    expect(prompt).toContain('(further skill instructions omitted for length)')
    expect(prompt).not.toContain('call the use_skill tool')
  })

  it('adds no skills section when none are installed', () => {
    expect(buildModeSystemPrompt('chat')).not.toContain('Installed skills')
    expect(buildModeSystemPrompt('chat', { skills: [] })).not.toContain('Installed skills')
  })
})
