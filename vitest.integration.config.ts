import { defineConfig } from 'vitest/config';

// Entegrasyon testleri gerçek sunucular ve sabit portlar kullanır: dosyalar
// sırayla, tek tek çalışır.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    reporters: ['verbose'],
  },
});
