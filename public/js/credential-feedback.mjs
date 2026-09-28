/** A save and a connectivity check are different outcomes; neither implies the other. */
export async function completeCredentialUpdate({ save, verify, refresh, show, savedMessage = 'Saved.', initialMessage = 'Saving…' }) {
  let saved;
  show(initialMessage, false);
  try { saved = await save(); }
  catch (error) { show(`Could not save: ${error.message}`, true); return { saved: false }; }
  show(`${savedMessage} Checking GoLogin…`, false);
  let checks;
  try { checks = await verify(saved); }
  catch (error) { show(`${savedMessage} Could not verify GoLogin: ${error.message}`, true); return { saved: true, verified: false }; }
  const failures = checks.filter(c => !c.ok);
  const good = checks.filter(c => c.ok);
  const summary = good.map(c => `${c.label}: ${c.profileCount} account${c.profileCount === 1 ? '' : 's'}`).join('; ');
  if (failures.length) {
    show(`${savedMessage} ${failures.map(c => `${c.label || 'Workspace'}: ${c.error}`).join(' ')}${summary ? ` Working: ${summary}.` : ''}`, true);
    return { saved: true, verified: false };
  }
  show(`${savedMessage} ${summary ? `GoLogin connected — ${summary}. ` : ''}Refreshing accounts…`, false);
  try {
    const roster = await refresh();
    if (!roster?.ok) throw new Error(roster?.error || 'The account list could not be refreshed.');
    const warning = (roster.warnings || []).map(w => `${w.label}: ${w.error}`).join(' ');
    show(`${savedMessage} ${summary ? `GoLogin connected — ${summary}. ` : ''}Account list refreshed (${roster.count} account${roster.count === 1 ? '' : 's'}). Done.${warning ? ` Other workspaces need attention: ${warning}` : ''}`, !!warning);
    return { saved: true, verified: true, refreshed: true };
  } catch (error) {
    show(`${savedMessage} ${summary ? `Token verified (${summary}), but ` : ''}the account list did not finish loading: ${error.message} Use Check connection to retry.`, true);
    return { saved: true, verified: true, refreshed: false };
  }
}
