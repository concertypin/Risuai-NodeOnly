<script lang="ts">
    import { language } from "src/lang";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { alertConfirm, alertNormal } from "src/ts/alert";

    let compressing = $state(false);
    let progress = $state('');

    function formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    }

    async function compressAll() {
        const confirmed = await alertConfirm(language.inlayCompressConfirm);
        if (!confirmed) return;

        compressing = true;
        progress = '';

        try {
            const res = await fetch('/api/inlays/compress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quality: 85 }),
            });

            const reader = res.body?.getReader();
            if (!reader) throw new Error('No response body');

            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = JSON.parse(line.slice(6));

                    if (data.type === 'progress') {
                        progress = `${data.current} / ${data.total} (${formatBytes(data.totalSaved)} ${language.saved})`;
                    } else if (data.type === 'done') {
                        await alertNormal(
                            `${language.inlayCompressDone}: ${data.compressed}${language.inlayCompressCount}, ${formatBytes(data.totalSaved)} ${language.saved}`
                        );
                    } else if (data.type === 'error') {
                        await alertNormal(`Error: ${data.message}`);
                    }
                }
            }
        } catch (e) {
            await alertNormal(`Error: ${e?.message || e}`);
        } finally {
            compressing = false;
            progress = '';
        }
    }
</script>

<div class="mt-4">
    <ShButton
        className="w-full"
        onclick={compressAll}
        disabled={compressing}
    >
        {compressing ? language.inlayCompressing : language.inlayCompressAll}
    </ShButton>
    {#if progress}
        <p class="text-sm text-textcolor2 mt-2">{progress}</p>
    {/if}
</div>
