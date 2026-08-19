export const MAX_ROUTE_MATCH_LENGTH = 1_024;

function hasBackreference(source) {
  let inCharacterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      const next = source[index + 1];
      if (!inCharacterClass
        && (/[1-9]/.test(next || '') || (next === 'k' && source[index + 2] === '<'))) {
        return true;
      }
      index += 1;
    } else if (character === '[' && !inCharacterClass) {
      inCharacterClass = true;
    } else if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
    }
  }
  return false;
}

function unboundedQuantifierLength(source, index) {
  const character = source[index];
  if (character === '*' || character === '+') return 1;
  if (character !== '{') return 0;
  const match = /^\{\d+,\}/.exec(source.slice(index));
  return match ? match[0].length : 0;
}

function splitTopLevelAlternatives(source) {
  const alternatives = [];
  let start = 0;
  let depth = 0;
  let inCharacterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[' && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === '(') depth += 1;
    else if (character === ')' && depth > 0) depth -= 1;
    else if (character === '|' && depth === 0) {
      alternatives.push(source.slice(start, index));
      start = index + 1;
    }
  }
  if (!alternatives.length) return [];
  alternatives.push(source.slice(start));
  return alternatives;
}

function literalAlternative(source) {
  let literal = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      const escaped = source[index + 1];
      if (!escaped || /[A-Za-z0-9]/.test(escaped)) return null;
      literal += escaped;
      index += 1;
      continue;
    }
    if ('^$.*+?{}[]()|'.includes(character)) return null;
    literal += character;
  }
  return literal || null;
}

function ambiguousLiteralAlternatives(groupSource) {
  let body = groupSource;
  if (body.startsWith('?:')) body = body.slice(2);
  else if (body.startsWith('?<')) {
    const end = body.indexOf('>');
    if (end < 3 || body[2] === '=' || body[2] === '!') return false;
    body = body.slice(end + 1);
  } else if (body.startsWith('?')) {
    return false;
  }
  const alternatives = splitTopLevelAlternatives(body)
    .map(literalAlternative)
    .filter(Boolean);
  for (let left = 0; left < alternatives.length; left += 1) {
    for (let right = left + 1; right < alternatives.length; right += 1) {
      if (
        alternatives[left].startsWith(alternatives[right])
        || alternatives[right].startsWith(alternatives[left])
      ) return true;
    }
  }
  return false;
}

function hasAmbiguousRepeatedAlternatives(source) {
  const groups = [];
  let inCharacterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[' && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === '(') {
      groups.push({ start: index + 1, hasAmbiguousChild: false });
      continue;
    }
    if (character === ')' && groups.length) {
      const group = groups.pop();
      const ambiguous = group.hasAmbiguousChild
        || ambiguousLiteralAlternatives(source.slice(group.start, index));
      if (ambiguous && unboundedQuantifierLength(source, index + 1) > 0) return true;
      if (ambiguous && groups.length) groups.at(-1).hasAmbiguousChild = true;
    }
  }
  return false;
}

function hasNestedUnboundedQuantifier(source) {
  const groups = [{ hasUnbounded: false }];
  let inCharacterClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '[' && !inCharacterClass) {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === '(') {
      groups.push({ hasUnbounded: false });
      continue;
    }
    if (character === ')' && groups.length > 1) {
      const group = groups.pop();
      const repeatedWithoutBound = unboundedQuantifierLength(source, index + 1) > 0;
      if (group.hasUnbounded && repeatedWithoutBound) return true;
      if (group.hasUnbounded || repeatedWithoutBound) groups.at(-1).hasUnbounded = true;
      continue;
    }
    if (unboundedQuantifierLength(source, index) > 0) {
      groups.at(-1).hasUnbounded = true;
    }
  }
  return false;
}

/**
 * 只做有界的正则源码静态检查，不编译或执行表达式。
 * 返回值仅用于稳定诊断；null 表示未命中当前禁止规则，不代表完整形式化证明。
 */
export function routeMatchSafetyIssue(source) {
  if (typeof source !== 'string') return null;
  if (source.length > MAX_ROUTE_MATCH_LENGTH) return 'too_long';
  if (hasBackreference(source)) return 'backreference';
  if (hasNestedUnboundedQuantifier(source)) return 'nested_unbounded_quantifier';
  if (hasAmbiguousRepeatedAlternatives(source)) return 'ambiguous_repeated_alternative';
  return null;
}
