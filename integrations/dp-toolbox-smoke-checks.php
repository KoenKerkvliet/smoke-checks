<?php
/**
 * Name: Smoke-checks koppeling
 * Description: Meldt deze site automatisch aan bij het smoke-checks-dashboard (als 'pending', jij keurt goed) en start na elke plugin-update een test-run. Aanmelden werkt zonder config; de update-trigger vereist SMOKE_GH_TOKEN.
 * Sites: *
 * Status: active
 * Version: 1.1.0
 *
 * Plaats als DP Toolbox code-snippet (dp-toolbox/modules/code-snippets/snippets/)
 * of als losse mu-plugin.
 *
 * Auto-aanmelden werkt out-of-the-box (zero-config). Aanmeldingen landen 'pending'
 * en moeten in het dashboard goedgekeurd worden — het token hieronder is daarom
 * bewust slechts een spam-filter, geen geheim.
 *
 * Optioneel in wp-config.php:
 *   define('SMOKE_GH_TOKEN', 'github_pat_...');  // ECHT geheim: PAT voor de 'test na plugin-update'-trigger
 *   // define('SMOKE_ENROLL_SECRET', '...');     // eigen enrollment-token i.p.v. de default
 *   // define('SMOKE_SITE_SLUG', 'eigen-slug');  // standaard afgeleid van de host
 *   // define('SMOKE_ENROLL_URL', 'https://<ref>.supabase.co/functions/v1/enroll-site');
 *   // define('SMOKE_REPO', 'KoenKerkvliet/smoke-checks');
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

// Publiek enrollment-token (spam-filter; aanmeldingen zijn approval-gated in het dashboard).
if ( ! defined( 'SMOKE_DEFAULT_ENROLL_TOKEN' ) ) {
    define( 'SMOKE_DEFAULT_ENROLL_TOKEN', '71fece5a0c0741c882fe3dcdc8a01a7d6476662832bf45779b8b0a12331cce6e' );
}

if ( ! function_exists( 'smoke_checks_slug' ) ) {
    /**
     * Slug afgeleid van de host (zelfde logica als de enroll-functie).
     */
    function smoke_checks_slug(): string {
        if ( defined( 'SMOKE_SITE_SLUG' ) && SMOKE_SITE_SLUG ) {
            return (string) SMOKE_SITE_SLUG;
        }
        $host = wp_parse_url( home_url(), PHP_URL_HOST ) ?: home_url();
        $host = preg_replace( '/^www\./', '', strtolower( $host ) );
        $slug = trim( (string) preg_replace( '/[^a-z0-9]+/', '-', $host ), '-' );
        return substr( $slug, 0, 60 ) ?: 'site';
    }
}

/**
 * Auto-aanmelden bij het dashboard (eenmalig, landt op 'pending').
 */
add_action( 'admin_init', function (): void {
    $slug = smoke_checks_slug();
    if ( get_option( 'smoke_checks_enrolled' ) === $slug ) {
        return; // al aangemeld voor deze slug
    }

    $secret = ( defined( 'SMOKE_ENROLL_SECRET' ) && SMOKE_ENROLL_SECRET )
        ? SMOKE_ENROLL_SECRET
        : SMOKE_DEFAULT_ENROLL_TOKEN;

    $url = defined( 'SMOKE_ENROLL_URL' )
        ? SMOKE_ENROLL_URL
        : 'https://ncbzotjsefjunnnmgrgh.supabase.co/functions/v1/enroll-site';

    $resp = wp_remote_post( $url, [
        'timeout' => 15,
        'headers' => [
            'Content-Type'    => 'application/json',
            'x-enroll-secret' => $secret,
        ],
        'body' => wp_json_encode( [
            'url'  => home_url(),
            'name' => get_bloginfo( 'name' ),
            'slug' => $slug,
        ] ),
    ] );

    if ( ! is_wp_error( $resp ) && (int) wp_remote_retrieve_response_code( $resp ) < 300 ) {
        update_option( 'smoke_checks_enrolled', $slug );
    }
} );

/**
 * Na een afgeronde plugin-update: start een run voor deze site.
 */
add_action( 'upgrader_process_complete', function ( $upgrader, $options ): void {
    if ( ( $options['action'] ?? '' ) !== 'update' || ( $options['type'] ?? '' ) !== 'plugin' ) {
        return;
    }
    if ( ! defined( 'SMOKE_GH_TOKEN' ) || ! SMOKE_GH_TOKEN ) {
        return;
    }

    static $fired = false;
    if ( $fired ) {
        return;
    }
    $fired = true;

    $repo = defined( 'SMOKE_REPO' ) ? SMOKE_REPO : 'KoenKerkvliet/smoke-checks';
    $resp = wp_remote_post( "https://api.github.com/repos/{$repo}/dispatches", [
        'timeout' => 15,
        'headers' => [
            'Authorization' => 'Bearer ' . SMOKE_GH_TOKEN,
            'Accept'        => 'application/vnd.github+json',
            'Content-Type'  => 'application/json',
            'User-Agent'    => 'smoke-checks-trigger',
        ],
        'body' => wp_json_encode( [
            'event_type'     => 'site-updated',
            'client_payload' => [
                'site'    => smoke_checks_slug(),
                'updated' => array_values( (array) ( $options['plugins'] ?? [] ) ),
            ],
        ] ),
    ] );

    if ( is_wp_error( $resp ) ) {
        error_log( '[smoke-checks] dispatch mislukt: ' . $resp->get_error_message() );
    }
}, 10, 2 );
