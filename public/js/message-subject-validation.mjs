// Any route that can send via Sales Navigator needs a subject, including fallback.
export function messageSubjectError({mode, templates = {}, messageOpenProfiles = false} = {}) {
  const usesOpenProfile = mode === 'open_profile_only' || (mode === 'connect_only' && messageOpenProfiles);
  if (usesOpenProfile && templates.opChannel !== 'ln_only' && !String(templates.openProfileSubject || templates.opSubject || '').trim()) {
    return 'Add a subject to the message template before starting. Sales Navigator messages require a subject.';
  }
  return '';
}
