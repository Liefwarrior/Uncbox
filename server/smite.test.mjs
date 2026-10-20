import { describe, expect, it } from 'vitest';
import { applyLine, emptySmite } from './smite.mjs';

// Real SMITE 2 log lines (Hemingway.log), trimmed.
const LINES = [
  '[2026.10.16-21.22.15:851][  0]LogLoad: LoadMap: 20.157.93.37:9609/Game/Maps/Lobbies/MatchLobby/L_MatchLobby_P?RHSessionId=x',
  '[2026.10.16-21.22.40:000][ 10]LogHWBanPickDraft: Warning: Nike locked. Local Team: 1, Task Team: 1',
  '[2026.10.16-21.22.41:000][ 10]LogHWBanPickDraft: Warning: Morgan Le Fay locked. Local Team: 1, Task Team: 2',
  '[2026.10.16-21.22.42:000][ 10]LogHWBanPickDraft: Warning: Morgan Le Fay locked. Local Team: 1, Task Team: 2',
  '[2026.10.16-21.22.43:000][ 10]LogHWBanPickDraft: Warning: Hachiman locked. Local Team: 1, Task Team: 1',
  '[2026.10.16-21.23.32:630][581]LogWorld: SeamlessTravel to: /Game/Maps/Conquest/Year0/F2P/L_CQ_F2P_P',
  '[2026.10.16-21.23.40:000][600]LogHWAbilityInput: Set Targeting Ability Default__GA_Hachiman_A02_C with Activation failure tags',
  '[2026.10.16-21.23.57:966][601]LogHemingway: UHWItemStoreManagerComponent::PurchaseItem - EquipmentToCraft->DevName: LeatherCowl  EquipmentItem->DevName: LeatherCowl',
  '[2026.10.16-21.24.08:257][602]LogHemingway: UHWItemStoreManagerComponent::PurchaseItem - EquipmentToCraft->DevName: Health Potion  EquipmentItem->DevName: Health Potion',
  "[2026.10.16-21.28.02:375][603]LogHemingway: UHWItemStoreManagerComponent::PurchaseItem - EquipmentToCraft->DevName: Devourer's Gauntlet  EquipmentItem->DevName: Devourer's Gauntlet",
  "[2026.10.16-21.28.02:663][604]LogHemingway: UHWItemStoreManagerComponent::PurchaseItem - EquipmentToCraft->DevName: Devourer's Gauntlet  EquipmentItem->DevName: Devourer's Gauntlet",
  '[2026.10.16-21.55.02:416][  0]LogLoad: LoadMap: /Game/Maps/Lobbies/MainLobby/L_MainLobby_P?Name=Player',
];

describe('SMITE 2 log', () => {
  it('follows a match from draft to lobby', () => {
    const states = [];
    let s = emptySmite();
    for (const line of LINES) states.push((s = applyLine(s, line)));
    const inMatch = states[states.length - 2];
    expect(inMatch).toMatchObject({
      phase: 'match',
      mode: 'Conquest',
      startedAt: Date.UTC(2026, 9, 16, 21, 23, 32, 630),
      god: 'Hachiman',
      allies: ['Nike', 'Hachiman'],
      enemies: ['Morgan Le Fay'],
      build: ['Leather Cowl', "Devourer's Gauntlet"],
      consumables: { 'Health Potion': 1 },
    });
    expect(s).toMatchObject({ phase: 'lobby', endedAt: Date.UTC(2026, 9, 16, 21, 55, 2, 416), god: 'Hachiman' });
    // A line that changes nothing keeps the same object, so nothing is sent.
    expect(applyLine(s, '[2026.10.16-21.55.03:000][  1]LogTemp: nothing')).toBe(s);
  });
});
