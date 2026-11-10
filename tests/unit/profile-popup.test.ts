import { expect, test } from 'bun:test';
import { reduce } from '../../src/popup/controller';
import { createTranslator } from '../../src/popup/i18n';
import { initialState } from '../../src/popup/state';
import { renderPopup } from '../../src/popup/view';
import { PNG } from '../fixtures/profile';

test('prefill keeps metadata and automatic provenance until the person edits it', () => {
  const s = reduce(initialState(), {
    type: 'add-probed',
    found: {
      idTail: '1001',
      defaultName: 'Alice',
      profile: { handle: '@alice', avatar: PNG },
      autoLabel: true,
    },
  }).state;
  expect(s.adding).toMatchObject({ profile: { handle: '@alice' }, autoLabel: true });
  expect(reduce(s, { type: 'add-save' }).effects[0]).toMatchObject({ autoLabel: true });
  const edited = reduce(s, { type: 'input', field: 'add', value: 'My Alice' }).state;
  expect(reduce(edited, { type: 'add-save' }).effects[0]).not.toMatchObject({ autoLabel: true });
});
test('rows render page metadata as text and validated local avatar only', () => {
  const s = initialState();
  s.platforms.facebook.accounts = [
    {
      id: 'a',
      label: '<img src=x onerror=alert(1)>',
      initials: 'A',
      sub: { kind: 'id', tail: '1001' },
      used: { kind: 'now' },
      expired: false,
      profile: {
        displayName: '<b>Alice</b>',
        handle: '<svg onload=alert(1)>',
        email: 'a@example.test',
        avatar: PNG,
      },
    },
  ];
  const root = document.createElement('main');
  renderPopup(root, s, createTranslator('en'));
  expect(root.querySelector('.profile-details')?.textContent).toContain('<svg onload=alert(1)>');
  expect(root.querySelector('.who img')).toBeNull();
  expect(root.querySelector('.avatar > img')?.getAttribute('src')).toBe(PNG);
  expect(root.querySelector('.nm')?.textContent).toBe('<img src=x onerror=alert(1)>');
  const profile = s.platforms.facebook.accounts[0]?.profile;
  if (!profile) throw new Error('missing fixture');
  profile.avatar = 'https://evil.test/avatar.png';
  renderPopup(root, s, createTranslator('th'));
  expect(root.querySelector('.avatar > img')).toBeNull();
});

test('forgot-password explanation limits retained names to YouTube shortcuts', () => {
  const state = initialState();
  state.page = 'locked';
  state.lock.wipeConfirm = true;
  const root = document.createElement('main');
  renderPopup(root, state, createTranslator('en'));
  expect(root.querySelector('[data-testid="wipe-confirm"] small')?.textContent).toBe(
    'There is no password recovery (there is no server). Every saved session and its profile details are deleted, and you add those accounts again. YouTube shortcuts stay with the names you gave them; automatic names reset. Your accounts on the sites are fine.',
  );
  renderPopup(root, state, createTranslator('th'));
  expect(root.querySelector('[data-testid="wipe-confirm"] small')?.textContent).toBe(
    'กู้รหัสผ่านไม่ได้ (ไม่มี server) — session และข้อมูลโปรไฟล์ที่บันทึกไว้ทั้งหมดจะถูกลบ แล้วค่อยเพิ่มบัญชีเหล่านั้นใหม่ · ทางลัด YouTube ยังอยู่พร้อมชื่อที่คุณตั้งไว้ ส่วนชื่ออัตโนมัติจะถูกรีเซ็ต · บัญชีบนเว็บไม่เสียหาย',
  );
});
