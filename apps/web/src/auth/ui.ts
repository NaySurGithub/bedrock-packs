import { AccountClient } from './client.js';
import { BrowserAuthTransport } from './transport.js';
import { AccountVault } from './vault.js';
import type { AuthConfig, AccountState } from './types.js';

function authUrl(): URL {
    if (import.meta.env.VITE_AUTH_URL) {
        return new URL(import.meta.env.VITE_AUTH_URL, location.href);
    }

    if (import.meta.env.VITE_RELAY_URL) {
        const url = new URL('/auth', import.meta.env.VITE_RELAY_URL);
        url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
        return url;
    }

    if (!import.meta.env.DEV) {
        throw new Error('Configure VITE_AUTH_URL or VITE_RELAY_URL to enable sign-in.');
    }

    return new URL('/auth', location.href);
}

export function mountAccount(
    button: HTMLButtonElement,
    config: AuthConfig,
    onClient?: (client: AccountClient) => void,
): () => void {
    const dialog = document.createElement('dialog');
    dialog.className = 'account-dialog';
    dialog.setAttribute('aria-labelledby', 'account-title');
    dialog.innerHTML = `
        <div class="dialog-heading">
            <h2 id="account-title">Microsoft account</h2>
            <button class="dialog-close" type="button" aria-label="Close">×</button>
        </div>
        <p id="account-message" role="status" aria-live="polite"></p>
        <div id="device-panel" hidden>
            <p>Enter this code on Microsoft's website:</p>
            <div class="device-code-row">
                <output id="device-code" aria-label="Microsoft sign-in code"></output>
                <button id="copy-code" class="secondary-button" type="button">Copy code</button>
            </div>
            <a id="verification-link" class="verification-link" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Enter code at Microsoft ↗</a>
            <p id="code-expiry" class="account-secondary"></p>
        </div>
        <dl id="account-details" class="account-details" hidden>
            <dt>Gamertag</dt><dd id="account-gamertag"></dd>
            <dt>Xbox ID</dt><dd id="account-xuid"></dd>
        </dl>
        <p class="account-storage-note">Tokens are encrypted and saved in this browser.</p>
        <div class="dialog-actions">
            <button id="account-clear" class="secondary-button" type="button" hidden>Sign out</button>
            <button id="account-retry" class="primary-button" type="button" hidden>Try again</button>
            <button id="account-cancel" class="secondary-button" type="button">Cancel</button>
        </div>
    `;

    document.body.append(dialog);

    const message = dialog.querySelector<HTMLParagraphElement>('#account-message')!;
    const devicePanel = dialog.querySelector<HTMLDivElement>('#device-panel')!;
    const code = dialog.querySelector<HTMLOutputElement>('#device-code')!;
    const expiry = dialog.querySelector<HTMLParagraphElement>('#code-expiry')!;
    const link = dialog.querySelector<HTMLAnchorElement>('#verification-link')!;
    const details = dialog.querySelector<HTMLDListElement>('#account-details')!;
    const gamertag = dialog.querySelector<HTMLElement>('#account-gamertag')!;
    const xuid = dialog.querySelector<HTMLElement>('#account-xuid')!;
    const clear = dialog.querySelector<HTMLButtonElement>('#account-clear')!;
    const retry = dialog.querySelector<HTMLButtonElement>('#account-retry')!;
    const cancel = dialog.querySelector<HTMLButtonElement>('#account-cancel')!;
    const copy = dialog.querySelector<HTMLButtonElement>('#copy-code')!;

    const client = new AccountClient({
        config,
        store: new AccountVault(),
        transport: new BrowserAuthTransport(authUrl()),
    });
    onClient?.(client);

    let current: AccountState = { status: 'restoring' };
    let countdown: ReturnType<typeof setInterval> | undefined;

    const subscribe = client.subscribe((state) => {
        current = state;
        clearInterval(countdown);
        devicePanel.hidden = state.status !== 'device-code';
        details.hidden = state.status !== 'signed-in';
        retry.hidden = state.status !== 'error';
        clear.hidden = state.status !== 'signed-in' && state.status !== 'error';
        clear.textContent = state.status === 'signed-in' ? 'Sign out' : 'Clear saved account';
        cancel.textContent = state.status === 'signed-in' ? 'Close' : 'Cancel';
        button.disabled = state.status === 'restoring';
        message.classList.toggle('account-error', state.status === 'error');

        if (state.status !== 'device-code') {
            code.value = '';
            link.removeAttribute('href');
        }

        const label = button.querySelector<HTMLElement>('.account-label')!;
        label.textContent =
            state.status === 'signed-in'
                ? state.gamertag
                : state.status === 'restoring'
                  ? 'Restoring account…'
                  : 'Sign in with Microsoft';

        switch (state.status) {
            case 'restoring':
                message.textContent = 'Restoring your saved session…';
                break;

            case 'signed-out':
                message.textContent = 'Sign in with Microsoft to use your Xbox account.';
                break;

            case 'connecting':
                message.textContent = state.message;
                break;

            case 'device-code': {
                message.textContent = 'Waiting for Microsoft approval.';
                code.value = state.device.code;
                link.href = state.device.verificationUri;
                copy.textContent = 'Copy code';

                const updateExpiry = () => {
                    const seconds = Math.max(
                        0,
                        Math.ceil((state.device.expiresAt - Date.now()) / 1000),
                    );
                    const minutes = Math.floor(seconds / 60);
                    expiry.textContent = `Expires in ${minutes}:${String(seconds % 60).padStart(2, '0')}`;
                };

                updateExpiry();
                countdown = setInterval(updateExpiry, 1000);
                break;
            }

            case 'signed-in':
                message.textContent = 'Signed in. Your Xbox and Minecraft sessions are ready.';
                gamertag.textContent = state.gamertag;
                xuid.textContent = state.xuid;
                code.value = '';
                link.removeAttribute('href');
                break;

            case 'error':
                message.textContent = state.message;
                code.value = '';
                link.removeAttribute('href');
                break;
        }
    });

    const startSignIn = () => {
        if (!dialog.open) {
            dialog.showModal();
        }

        void client.signIn();
    };

    button.addEventListener('click', () => {
        if (
            current.status === 'signed-in' ||
            current.status === 'device-code' ||
            current.status === 'connecting'
        ) {
            dialog.showModal();
        } else {
            startSignIn();
        }
    });

    retry.addEventListener('click', startSignIn);

    const close = () => {
        if (current.status === 'device-code' || current.status === 'connecting') {
            client.cancel();
        }

        clearInterval(countdown);
        code.value = '';
        link.removeAttribute('href');
        dialog.close();
    };

    dialog.querySelector<HTMLButtonElement>('.dialog-close')!.addEventListener('click', close);
    cancel.addEventListener('click', close);
    dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        close();
    });

    clear.addEventListener('click', () => {
        clear.disabled = true;

        void client
            .signOut()
            .then(() => {
                dialog.close();
            })
            .catch(() => {
                message.textContent = 'Could not clear local account storage. Try again.';
            })
            .finally(() => {
                clear.disabled = false;
            });
    });

    copy.addEventListener('click', () => {
        void navigator.clipboard
            .writeText(code.value)
            .then(() => {
                copy.textContent = 'Copied';
            })
            .catch(() => {
                copy.textContent = 'Select the code to copy';
            });
    });

    const refresh = () => {
        if (document.visibilityState === 'visible') {
            void client.refresh();
        }
    };

    document.addEventListener('visibilitychange', refresh);
    void client.restore();

    return () => {
        subscribe();
        clearInterval(countdown);
        document.removeEventListener('visibilitychange', refresh);
        client.dispose();
        dialog.remove();
    };
}
