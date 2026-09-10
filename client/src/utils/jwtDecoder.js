export function decodeJWT(token) {
  try {
    const parts = token.trim().split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
    );
    return payload;
  } catch {
    return null;
  }
}

export function isExpired(payload) {
  if (!payload?.exp) return false;
  return Math.floor(Date.now() / 1000) > payload.exp;
}

export function getDisplayName(payload) {
  return (payload?.name || '').replace(/\$/g, ' ').trim() || payload?.email || 'User';
}

export function getInitials(name) {
  return name
    .split(/\s+/)
    .map(w => w[0] || '')
    .join('')
    .substring(0, 2)
    .toUpperCase();
}
