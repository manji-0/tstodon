// @ts-check
// The sign-in page's "Sign out" button (server/auth-pages.ts): a script file,
// as the content security policy runs no inline script.
(function () {
  'use strict';

  const form = document.getElementById('sign-out');
  const error = document.getElementById('error');
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const response = await fetch('/auth/sign_out', {
      method: 'DELETE',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      if (error) {
        error.textContent = response.statusText;
      }
      return;
    }
    const body = await response.json();
    location.assign(
      typeof body.redirect_to === 'string' ? body.redirect_to : form.dataset.logoutPath ?? '/',
    );
  });
})();
