// An HTTP success is only a transport observation. The selected operation
// must also return usable output and a successful terminal where applicable.
export function assessGatewayAnswer(entry, status, contentType, body) {
  const summary = { status, contentType, bytes: body.length, successfulAnswer: false };
  if (contentType.includes('text/event-stream')) {
    const raw = body.toString('utf8');
    summary.terminal = raw.includes('response.failed') ? 'failed' : raw.includes('response.completed') ? 'completed' : /(?:^|\n)data: \[DONE\]/.test(raw) ? 'done' : raw.includes('message_stop') ? 'message_stop' : 'missing';
    const events = raw.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => { try { return JSON.parse(line.slice(6)); } catch { return null; } }).filter(Boolean);
    summary.textCharacters = events.reduce((total, event) => total + (event.choices?.[0]?.delta?.content?.length ?? event.delta?.text?.length ?? (typeof event.delta === 'string' ? event.delta.length : 0)), 0);
    summary.finishReasons = [...new Set(events.map(event => event.choices?.[0]?.finish_reason).filter(Boolean))];
    summary.successfulAnswer = status === 200 && ['completed', 'done', 'message_stop'].includes(summary.terminal) && summary.textCharacters > 0 && !summary.finishReasons.includes('length') && !raw.includes('response.failed');
  } else if (contentType.includes('json') && body.length < (2 << 20)) {
    try {
      const response = JSON.parse(body.toString('utf8'));
      const responsesText = response.output?.filter(item => item.type === 'message').flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text ?? '').join('');
      const value = response.choices?.[0]?.message?.content ?? response.output_text ?? responsesText ?? response.content?.find(part => part.type === 'text')?.text;
      summary.finishReasons = [response.choices?.[0]?.finish_reason].filter(Boolean);
      summary.textCharacters = typeof value === 'string' ? value.length : 0;
      summary.vectors = response.data?.[0]?.embedding?.length ?? 0;
      summary.imageBytes = response.data?.[0]?.b64_json ? Buffer.from(response.data[0].b64_json, 'base64').length : 0;
      summary.usagePresent = Boolean(response.usage);
      const completedResponse = !Array.isArray(response.output) || response.status === 'completed' && !response.error && !response.incomplete_details;
      summary.successfulAnswer = status >= 200 && status < 300 && completedResponse && !summary.finishReasons.includes('length') && (summary.textCharacters > 0 || summary.vectors > 0 || summary.imageBytes > 0);
    } catch { summary.invalidJSON = true; }
  }
  return summary;
}
