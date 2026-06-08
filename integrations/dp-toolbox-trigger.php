<?php
/**
 * Name: Smoke-checks trigger
 * Description: Start na elke plugin-update een smoke-check-run via GitHub Actions (repository_dispatch).
 * Sites: *
 * Status: active
 * Version: 1.0.0
 *
 * Plaats dit bestand in de DP Toolbox code-snippets module
 * (dp-toolbox/modules/code-snippets/snippets/), of als losse mu-plugin.
 *
 * Vereist twee constantes in wp-config.php (NIET hardcoden in dit bestand):
 *   define('SMOKE_GH_TOKEN', 'github_pat_...');   // fine-grained PAT, alleen 'Contents: read' + 'repository_dispatch' op de repo
 *   define('SMOKE_SITE_SLUG', 'tvrapid');         // moet matchen met sites/<slug>.json
 */

if (! defined('ABSPATH')) {
    exit;
}

add_action('upgrader_process_complete', function ($upgrader, $options): void {
    // Alleen reageren op afgeronde plugin-updates.
    if (($options['action'] ?? '') !== 'update' || ($options['type'] ?? '') !== 'plugin') {
        return;
    }
    if (! defined('SMOKE_GH_TOKEN') || ! defined('SMOKE_SITE_SLUG')) {
        return;
    }

    // Eén keer per request triggeren (bulk-updates raken deze hook meerdere keren).
    static $fired = false;
    if ($fired) {
        return;
    }
    $fired = true;

    $repo = 'KoenKerkvliet/smoke-checks';
    $resp = wp_remote_post("https://api.github.com/repos/{$repo}/dispatches", [
        'timeout' => 15,
        'headers' => [
            'Authorization' => 'Bearer ' . SMOKE_GH_TOKEN,
            'Accept'        => 'application/vnd.github+json',
            'Content-Type'  => 'application/json',
            'User-Agent'    => 'smoke-checks-trigger',
        ],
        'body' => wp_json_encode([
            'event_type'     => 'site-updated',
            'client_payload' => [
                'site'    => SMOKE_SITE_SLUG,
                'updated' => array_values((array) ($options['plugins'] ?? [])),
            ],
        ]),
    ]);

    if (is_wp_error($resp)) {
        error_log('[smoke-checks] dispatch mislukt: ' . $resp->get_error_message());
    }
}, 10, 2);
