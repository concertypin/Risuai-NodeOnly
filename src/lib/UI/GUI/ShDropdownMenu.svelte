<script lang="ts">
    // shadcn-svelte DropdownMenu Root — ported to RisuAI theme tokens.
    // See _reference/shadcn-components/dropdown-menu/* for source patterns.
    // Pair with ShDropdownMenuTrigger, ShDropdownMenuContent, ShDropdownMenuItem,
    // ShDropdownMenuSeparator. bits-ui handles open/close, keyboard, focus, ARIA.
    import { DropdownMenu } from 'bits-ui';

    let { open = $bindable(false), ...restProps }: DropdownMenu.RootProps = $props();
</script>

<DropdownMenu.Root bind:open {...restProps} />
