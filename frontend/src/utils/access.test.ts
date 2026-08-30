import { describe, expect, it } from 'vitest';

import type { Capability, EffectiveRole } from '../types/api';
import {
  canUnlessUnknown,
  capabilitiesUnknown,
  hasCapability,
  memberRoles,
  roleAtLeast,
  roleHints,
  roleLabels,
} from './access';

describe('roleAtLeast', () => {
  it('ranks the ladder in the same order as the server', () => {
    expect(roleAtLeast('owner', 'manager')).toBe(true);
    expect(roleAtLeast('manager', 'manager')).toBe(true);
    expect(roleAtLeast('editor', 'manager')).toBe(false);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
    expect(roleAtLeast('editor', 'viewer')).toBe(true);
  });

  it('denies when the role is absent or unrecognised', () => {
    expect(roleAtLeast(undefined, 'viewer')).toBe(false);
    // The realistic source of an unknown value is a newer server. Ranking it as a
    // viewer would reveal actions on the strength of a string this build cannot
    // interpret, so it ranks as no access instead.
    expect(roleAtLeast('member' as EffectiveRole, 'viewer')).toBe(false);
    expect(roleAtLeast('' as EffectiveRole, 'viewer')).toBe(false);
  });
});

describe('hasCapability', () => {
  it('reads the list the server sent', () => {
    const kb = { capabilities: ['kb.read', 'chat.use'] as Capability[] };
    expect(hasCapability(kb, 'kb.read')).toBe(true);
    expect(hasCapability(kb, 'content.write')).toBe(false);
  });

  it('denies for a missing knowledge base or an empty list', () => {
    expect(hasCapability(null, 'kb.read')).toBe(false);
    expect(hasCapability(undefined, 'kb.read')).toBe(false);
    expect(hasCapability({ capabilities: [] }, 'kb.read')).toBe(false);
    expect(hasCapability({}, 'kb.read')).toBe(false);
  });
});

describe('capabilitiesUnknown', () => {
  it('separates "not loaded" from "loaded without a list"', () => {
    expect(capabilitiesUnknown(null)).toBe(false);
    expect(capabilitiesUnknown({})).toBe(true);
    // An empty list is an answer: this caller holds nothing.
    expect(capabilitiesUnknown({ capabilities: [] })).toBe(false);
  });
});

describe('canUnlessUnknown', () => {
  it('shows the action when the server never said', () => {
    expect(canUnlessUnknown({}, 'content.write')).toBe(true);
  });

  it('respects an explicit answer in both directions', () => {
    expect(canUnlessUnknown({ capabilities: [] }, 'content.write')).toBe(false);
    expect(canUnlessUnknown({ capabilities: ['content.write'] }, 'content.write')).toBe(true);
  });

  it('hides the action while nothing is loaded', () => {
    expect(canUnlessUnknown(null, 'content.write')).toBe(false);
  });
});

describe('role vocabulary', () => {
  it('offers exactly the three assignable roles, lowest first', () => {
    // Lowest first because the selector defaults to the first entry, and the safe
    // default for a new member is the least access.
    expect(memberRoles).toEqual(['viewer', 'editor', 'manager']);
  });

  it('labels every role, including owner, and hints every assignable one', () => {
    for (const role of [...memberRoles, 'owner' as const]) {
      expect(roleLabels[role]).toBeTruthy();
    }
    for (const role of memberRoles) {
      expect(roleHints[role]).toBeTruthy();
    }
    expect(Object.keys(roleHints)).toHaveLength(memberRoles.length);
  });
});
