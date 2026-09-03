import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces a hash that is not the plain password', async () => {
    const hash = await service.hash('correct-horse-battery');

    expect(hash).not.toBe('correct-horse-battery');
    expect(hash.length).toBeGreaterThan(50);
  });

  it('verifies a correct password', async () => {
    const hash = await service.hash('correct-horse-battery');

    await expect(service.verify('correct-horse-battery', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await service.hash('correct-horse-battery');

    await expect(service.verify('wrong', hash)).resolves.toBe(false);
  });

  it('produces a different hash each time for the same password', async () => {
    const first = await service.hash('same-password');
    const second = await service.hash('same-password');

    expect(first).not.toBe(second);
  });
});
