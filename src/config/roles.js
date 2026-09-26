export const ROLE_LABELS = Object.freeze({
  '1487264228342497384': 'Conseil O5',
  '1487283676516716606': 'Département Administratif',
  '1487266203864006707': 'Comité d’éthique',
  '1532038160643653704': 'ASIA',
  '1487266428179452036': 'DOS',
  '1487272686483804261': 'FIM',
});

/**
 * Maps raw Discord role IDs to the structured grade records the profile page
 * renders: the display label plus, when available, the source Discord role
 * name. Roles absent from ROLE_LABELS are ignored.
 */
export function getGrades(roleIds = [], roleNames = new Map()) {
  return roleIds.flatMap((roleId) => {
    const label = ROLE_LABELS[roleId];
    if (!label) return [];
    return [{
      roleId,
      label,
      roleName: roleNames instanceof Map ? roleNames.get(roleId) || null : null,
    }];
  });
}

/** Flat list of grade labels, for callers that only need the strings. */
export function getRoleLabels(roleIds = []) {
  return getGrades(roleIds).map((grade) => grade.label);
}
