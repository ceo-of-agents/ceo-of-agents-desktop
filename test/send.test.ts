import { describe, expect, it, vi } from 'vitest';
import { MAX_IMAGES } from '../src/shared/images';
import { sendMessage } from '../src/main/send';
import { attachment } from './helpers-images';
import { MAX_FILES } from '../src/shared/attachments';
import type { FileAttachment } from '../src/shared/types';

function setup() {
  const send = vi.fn();
  const session = vi.fn(() => ({ send }));
  return { send, session, deps: { orgs: { session } as never } };
}

describe('send (main-side validation)', () => {
  it('text only goes through as before', () => {
    const { send, deps } = setup();
    sendMessage(deps, 'o1', 'cos', 'hello');
    expect(send).toHaveBeenCalledWith('cos', 'hello', undefined, [], []);
  });

  it('empty or blank text with no image is ignored', () => {
    const { send, session, deps } = setup();
    sendMessage(deps, 'o1', 'cos', '');
    sendMessage(deps, 'o1', 'cos', '   \n');
    sendMessage(deps, 'o1', 'cos', '', []);
    sendMessage(deps, 'o1', 'cos', 42 as never);
    expect(session).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('empty text is fine with at least one image', () => {
    const { send, deps } = setup();
    const img = attachment();
    sendMessage(deps, 'o1', 'tab:1', '', [img]);
    expect(send).toHaveBeenCalledWith('tab:1', '', undefined, [img], []);
  });

  it('text with images goes through', () => {
    const { send, deps } = setup();
    const imgs = [attachment('image/png'), attachment('image/webp')];
    sendMessage(deps, 'o1', 'cos', 'see', imgs);
    expect(send).toHaveBeenCalledWith('cos', 'see', undefined, imgs, []);
  });

  it('drops the whole send, with an error, when any image fails', () => {
    const { send, deps } = setup();
    const cases: Array<[unknown[], RegExp]> = [
      [[attachment(), { mediaType: 'image/bmp', data: attachment().data }], /PNG, JPEG, GIF and WebP/],
      [[attachment(), { mediaType: 'image/png', data: attachment('image/gif').data }], /not a valid image/],
      [[{ mediaType: 'image/png', data: `data:image/png;base64,${attachment().data}` }], /not a valid image/],
      [Array.from({ length: MAX_IMAGES + 1 }, () => attachment()), /At most 5 images/],
      [[attachment('image/png', 4 * 1024 * 1024)], /over 3.75 MB/],
    ];
    cases.forEach(([imgs, msg], i) => expect(() => sendMessage(deps, 'o1', 'cos', 'text', imgs), `case ${i}`).toThrow(msg));
    expect(() => sendMessage(deps, 'o1', 'cos', 'text', 'not a list')).toThrow(/not a valid image/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('send with files', () => {
  const file = (name: string, type: string, size = 10): FileAttachment => ({ name, mediaType: type, data: new Uint8Array(size).fill(1) });

  it('a file alone, with empty text, goes through', () => {
    const { send, deps } = setup();
    const f = file('report.pdf', 'application/pdf');
    sendMessage(deps, 'o1', 'cos', '', undefined, [f]);
    expect(send).toHaveBeenCalledWith('cos', '', undefined, [], [f]);
  });

  it('drops the whole send, with a clear error, when a file fails', () => {
    const { send, deps } = setup();
    const cases: Array<[unknown, RegExp]> = [
      [[file('clip.mp4', 'video/mp4', 100 * 1024 * 1024 + 1)], /clip\.mp4 is over 100 MB/],
      [[file('a.pdf', 'application/pdf', 0)], /a\.pdf is empty/],
      [Array.from({ length: MAX_FILES + 1 }, () => file('a.txt', 'text/plain')), /At most 10 files/],
      [[{ name: 'x', mediaType: 'text/plain', data: 'not bytes' }], /empty or cannot be read/],
      ['not a list', /empty or cannot be read/],
    ];
    cases.forEach(([files, msg], i) => expect(() => sendMessage(deps, 'o1', 'cos', 'text', undefined, files), `case ${i}`).toThrow(msg));
    expect(send).not.toHaveBeenCalled();
  });
});
