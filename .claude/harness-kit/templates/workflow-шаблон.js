// Шаблон многоагентного прогона для инструмента Workflow. Скопировать в дом
// активности, заменить ЗАГЛАВНЫЕ места. Правила, которые шаблон закрепляет:
// бюджет и его учёт (budget), базовый путь через args, одна единица работы на
// агента, судьи плюс критик расхождений, запись того, что отброшено.
// Ограничения инструмента: в скрипте нет файловой системы, часов и случайности;
// runId и команду возобновления после запуска записывает в HANDOFF оператор.
export const meta = {
  name: 'ИМЯ-ПРОГОНА',
  description: 'ОДНА СТРОКА: что делает прогон и что лежит на выходе',
  phases: [
    { title: 'Разведка', detail: 'параллельные читатели по зонам' },
    { title: 'Синтез', detail: 'один агент собирает карту' },
    { title: 'Проверка', detail: 'скептики по кандидатам' },
    { title: 'Критик', detail: 'разбор расхождений судей' },
  ],
}

// Параметры прогона приходят через args (Workflow({ args: {...} })).
// Пример: { wt: '/абсолютный/путь/к/worktree', today: '2026-10-28', budgetTokens: 1500000, maxAgents: 12 }
const WT = (args && args.wt) || '.'
const TODAY = (args && args.today) || 'ДАТА-НЕ-ПЕРЕДАНА'
const MAX_AGENTS = (args && args.maxAgents) || 12
const RESERVE = 80000 // токенов на синтез и критика, не тратить на разведку

const COMMON = `Репозиторий: ${WT}. Сегодня ${TODAY}. Работаешь только на чтение.
Каждое утверждение с путём к файлу и строкой. Факты проверяй по git и файлам,
не по фокусу и не по HANDOFF: оба могут быть устаревшими. У каждого источника
укажи дату и пометку «снимок» или «живое». Не выдумывай: чего нет в файлах,
того нет. Отвечай по-русски.`

const FINDINGS = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'object', properties: {
      claim: { type: 'string' }, evidence: { type: 'string' }, source_date: { type: 'string' } },
      required: ['claim', 'evidence'] } },
    files_read: { type: 'array', items: { type: 'string' } },
  },
  required: ['items', 'files_read'],
}
const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    confidence: { type: 'string', enum: ['низкая', 'средняя', 'высокая'] },
    reasoning: { type: 'string' },
    corrections: { type: 'array', items: { type: 'string' } },
    evidence_files: { type: 'array', items: { type: 'string' } },
  },
  required: ['refuted', 'confidence', 'reasoning', 'corrections', 'evidence_files'],
}
const CRITIC = {
  type: 'object',
  properties: {
    contradictions: { type: 'array', items: { type: 'string' } },
    stale_sources: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string' },
  },
  required: ['contradictions', 'stale_sources', 'gaps', 'verdict'],
}

function enoughBudget(label) {
  if (budget.total && budget.remaining() < RESERVE) {
    log(`Бюджет: осталось ${Math.round(budget.remaining() / 1000)}k, пропускаю ${label}`)
    return false
  }
  return true
}

phase('Разведка')
const ZONES = [
  { key: 'ЗОНА-1', prompt: 'ЧТО ЧИТАТЬ И ЧТО ВЫЯСНИТЬ' },
  { key: 'ЗОНА-2', prompt: 'ЧТО ЧИТАТЬ И ЧТО ВЫЯСНИТЬ' },
].slice(0, MAX_AGENTS)
log(`Разведка: ${ZONES.length} зон, бюджет ${budget.total ? budget.total : 'не задан'}`)
const scouting = (await parallel(ZONES.map(z => () =>
  enoughBudget(`разведка ${z.key}`)
    ? agent(`${COMMON}\n\n${z.prompt}`, { label: `разведка:${z.key}`, phase: 'Разведка', schema: FINDINGS })
    : Promise.resolve(null)
))).filter(Boolean)
if (scouting.length < ZONES.length) log(`Пропущено зон: ${ZONES.length - scouting.length} (бюджет или сбой)`)

phase('Синтез')
const synth = enoughBudget('синтез')
  ? await agent(`${COMMON}\n\nСобери карту из результатов разведки (JSON ниже). Кандидаты нумеруй.\n${JSON.stringify(scouting)}`,
      { label: 'синтез', phase: 'Синтез', schema: FINDINGS })
  : null
const candidates = (synth && synth.items) ? synth.items.slice(0, MAX_AGENTS) : []
if (synth && synth.items && synth.items.length > candidates.length) log(`Кандидатов отброшено по лимиту агентов: ${synth.items.length - candidates.length}`)

phase('Проверка')
const LENSES = [
  'линза «уже есть или не нужно»: докажи, что это уже реализовано или боли нет',
  'линза «не взлетит»: докажи, что нет исполнителя, окружения, критерия готово или это противоречит решениям владельца',
]
const judged = await parallel(candidates.map(c => () =>
  parallel(LENSES.map((lens, i) => () =>
    enoughBudget(`скептик ${i + 1}`)
      ? agent(`${COMMON}\n\nКандидат: ${JSON.stringify(c)}\nТы скептик, ${lens}. Если не уверен, refuted=true.`,
          { label: `скептик${i + 1}`, phase: 'Проверка', schema: VERDICT })
      : Promise.resolve(null)
  )).then(votes => ({ candidate: c, votes: votes.filter(Boolean) }))
))

phase('Критик')
const critic = !enoughBudget('критик') ? null : await agent(`${COMMON}\n\nТы критик полноты и калибровки. Ниже кандидаты и вердикты скептиков.
Найди: где скептики противоречат друг другу, где вердикт опирается на устаревший
источник, что не прочитано. Единодушие судей без разбора расхождений не считается
качеством.\n${JSON.stringify(judged)}`, { label: 'критик', phase: 'Критик', schema: CRITIC })

return { scouting, synth, judged, critic, dropped_zones: ZONES.length - scouting.length }
// После завершения оператор пишет в HANDOFF строку «Прогоны»: дата, runId,
// модель/effort, токены, минуты, результат, команда Workflow({scriptPath, resumeFromRunId}).
