/** Format attended questions for terminal and historical compatibility views. */
export function renderQuestions(questions) {
  return (questions ?? []).map((q, index) => [
    `${index + 1}. ${q.text}`,
    q.why ? `   (why: ${q.why})` : '',
    q.options?.length ? `   options: ${q.options.join(' · ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}
