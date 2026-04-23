import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { isTransientError } from '../processzip'
import { HttpError } from '../../storage/nodeStorage'

// Mock all modules that have reactive effects to avoid side effects during tests
vi.mock('../../storage/database.svelte', () => ({
    getDatabase: vi.fn(() => ({
        assetSaveRetries: 3,
        assetSaveRetryDelay: 10,
        characters: [],
        modules: [],
        botPresets: [],
        loadouts: [],
        plugins: [],
        pluginCustomStorage: {},
    })),
    getCurrentChat: vi.fn(() => null),
    getCurrentCharacter: vi.fn(() => null),
    DBState: {
        db: {
            characters: [],
            modules: [],
            botPresets: [],
            loadouts: [],
            plugins: [],
            pluginCustomStorage: {},
        }
    },
    defaultSdDataFunc: vi.fn(),
}))

vi.mock('../../stores.svelte', () => ({
    selIdState: { selId: 0 },
    DBState: {
        db: {
            characters: [],
            modules: [],
            botPresets: [],
            loadouts: [],
            plugins: [],
            pluginCustomStorage: {},
        }
    },
    botMakerMode: { subscribe: vi.fn() },
    selectedCharID: { subscribe: vi.fn() },
}))

vi.mock('../../parser/parser.svelte', () => ({
    hasher: vi.fn(() => Promise.resolve('mock-hash')),
}))

vi.mock('../../alert', () => ({
    alertStore: { set: vi.fn() },
}))

vi.mock('../../characterCards', () => ({
    hubURL: 'https://mock-hub.url',
}))

vi.mock('../../util', () => ({
    sleep: vi.fn(() => Promise.resolve()),
    asBuffer: vi.fn((x) => x),
    Semaphore: class Semaphore {
        async acquire() {}
        release() {}
    }
}))

vi.mock('../../globalApi.svelte', () => ({
    saveAsset: vi.fn(() => Promise.resolve('assets/mock-id.png')),
    AppendableBuffer: class AppendableBuffer {
        buffer = new Uint8Array(0)
        append() {}
        clear() {}
    }
}))

vi.mock('../modules', () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
}))

vi.mock('../../process/modules', () => ({
    moduleUpdate: vi.fn(),
    getModules: vi.fn(() => []),
}))

describe('isTransientError', () => {
    it('returns true for 5xx server errors', () => {
        expect(isTransientError(new HttpError('msg', 500))).toBe(true)
        expect(isTransientError(new HttpError('msg', 502))).toBe(true)
        expect(isTransientError(new HttpError('msg', 503))).toBe(true)
        expect(isTransientError(new HttpError('msg', 504))).toBe(true)
        expect(isTransientError(new HttpError('msg', 599))).toBe(true)
    })

    it('returns true for 429 rate limit', () => {
        expect(isTransientError(new HttpError('msg', 429))).toBe(true)
    })

    it('returns false for 4xx client errors', () => {
        expect(isTransientError(new HttpError('msg', 400))).toBe(false)
        expect(isTransientError(new HttpError('msg', 401))).toBe(false)
        expect(isTransientError(new HttpError('msg', 404))).toBe(false)
        expect(isTransientError(new HttpError('msg', 409))).toBe(false)
    })

    it('returns true for network TypeError', () => {
        expect(isTransientError(new TypeError('fetch failed'))).toBe(true)
        expect(isTransientError(new TypeError('Network error'))).toBe(true)
    })

    it('returns false for other Error types', () => {
        expect(isTransientError(new Error('generic error'))).toBe(false)
        expect(isTransientError(new RangeError('range error'))).toBe(false)
    })

    it('returns false for non-Error values', () => {
        expect(isTransientError('string error')).toBe(false)
        expect(isTransientError(null)).toBe(false)
        expect(isTransientError(undefined)).toBe(false)
        expect(isTransientError(123)).toBe(false)
    })
})

describe('retryWithBackoff', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('succeeds on first attempt', async () => {
        const { retryWithBackoff } = await import('../processzip')
        const op = vi.fn().mockResolvedValue('ok')
        const result = await retryWithBackoff(op)
        expect(result).toBe('ok')
        expect(op).toHaveBeenCalledTimes(1)
    })

    it('succeeds after transient failure', async () => {
        const { retryWithBackoff } = await import('../processzip')
        const op = vi.fn()
            .mockRejectedValueOnce(new HttpError('502', 502))
            .mockResolvedValue('ok')
        const result = await retryWithBackoff(op)
        expect(result).toBe('ok')
        expect(op).toHaveBeenCalledTimes(2)
    })

    it('succeeds after multiple transient failures', async () => {
        const { retryWithBackoff } = await import('../processzip')
        const op = vi.fn()
            .mockRejectedValueOnce(new HttpError('502', 502))
            .mockRejectedValueOnce(new HttpError('503', 503))
            .mockRejectedValueOnce(new TypeError('network'))
            .mockResolvedValue('ok')
        const result = await retryWithBackoff(op)
        expect(result).toBe('ok')
        expect(op).toHaveBeenCalledTimes(4) // 3 failures + 1 success
    })

    it('fails after exhausting retries on transient error', async () => {
        const { retryWithBackoff } = await import('../processzip')
        const op = vi.fn().mockRejectedValue(new HttpError('502', 502))
        await expect(retryWithBackoff(op)).rejects.toThrow('502')
        expect(op).toHaveBeenCalledTimes(4) // initial + 3 retries
    })

    it('fails immediately on non-transient error', async () => {
        const { retryWithBackoff } = await import('../processzip')
        const op = vi.fn().mockRejectedValue(new HttpError('400', 400))
        await expect(retryWithBackoff(op)).rejects.toThrow('400')
        expect(op).toHaveBeenCalledTimes(1)
    })

    it('fails immediately on generic Error', async () => {
        const { retryWithBackoff } = await import('../processzip')
        const op = vi.fn().mockRejectedValue(new Error('generic error'))
        await expect(retryWithBackoff(op)).rejects.toThrow('generic error')
        expect(op).toHaveBeenCalledTimes(1)
    })

    it('calls sleep between retries', async () => {
        const { retryWithBackoff } = await import('../processzip')
        const { sleep } = await import('../../util')
        const op = vi.fn()
            .mockRejectedValueOnce(new HttpError('502', 502))
            .mockResolvedValue('ok')
        await retryWithBackoff(op)
        expect(sleep).toHaveBeenCalledTimes(1)
    })
})

describe('CharXImporter with unstable network', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    // Note: These tests would require more complex mocking of fflate and file streams
    // They are placeholder tests that demonstrate the expected behavior
    // Full integration tests should be run manually with actual network conditions

    it('placeholder: imports successfully despite transient asset save failures', async () => {
        // This test demonstrates the expected behavior pattern
        // Full implementation would require mocking fflate.Unzip and file streams
        const { retryWithBackoff, isTransientError } = await import('../processzip')

        // Verify that transient errors are identified correctly
        expect(isTransientError(new HttpError('502', 502))).toBe(true)

        // Verify retry behavior works
        const saveAssetMock = vi.fn()
            .mockRejectedValueOnce(new HttpError('502', 502))
            .mockRejectedValueOnce(new HttpError('503', 503))
            .mockResolvedValue('assets/success-id.png')

        const result = await retryWithBackoff(saveAssetMock)
        expect(result).toBe('assets/success-id.png')
        expect(saveAssetMock).toHaveBeenCalledTimes(3) // 2 failures + 1 success
    })

    it('placeholder: reports errors when all retries exhausted', async () => {
        const { retryWithBackoff, isTransientError } = await import('../processzip')

        // Verify that persistent transient errors exhaust retries
        const saveAssetMock = vi.fn().mockRejectedValue(new HttpError('502', 502))

        await expect(retryWithBackoff(saveAssetMock)).rejects.toThrow('502')
        expect(saveAssetMock).toHaveBeenCalledTimes(4) // initial + 3 retries
    })

    it('placeholder: fails immediately on non-transient 400 error', async () => {
        const { retryWithBackoff, isTransientError } = await import('../processzip')

        // Verify that non-transient errors don't retry
        expect(isTransientError(new HttpError('400', 400))).toBe(false)

        const saveAssetMock = vi.fn().mockRejectedValue(new HttpError('400', 400))

        await expect(retryWithBackoff(saveAssetMock)).rejects.toThrow('400')
        expect(saveAssetMock).toHaveBeenCalledTimes(1) // no retries
    })
})