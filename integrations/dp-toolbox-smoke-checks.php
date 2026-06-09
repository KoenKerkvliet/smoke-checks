<?php
/**
 * Name: Smoke-checks koppeling
 * Description: Meldt deze site automatisch aan bij het smoke-checks-dashboard (als 'pending', jij keurt goed) en start na elke plugin-, thema- of core-update een test-run (drift t.o.v. de nulmeting). Volledig zero-config.
 * Sites: *
 * Status: active
 * Version: 1.2.0
 *
 * Plaats als DP Toolbox code-snippet (dp-toolbox/modules/code-snippets/snippets/)
 * of als losse mu-plugin.
 *
 * Werkt out-of-the-box (zero-config): aanmelden én de update-trigger lopen via
 * edge functions met het token hieronder. Aanmeldingen landen 'pending' en moeten
 * in het dashboard goedgekeurd worden; het token is daarom bewust een spam-filter,
 * geen geheim. De echte GitHub-PAT staat server-side, niet op de site.
 *
 * Optioneel in wp-config.php:
 *   // define('SMOKE_ENROLL_SECRET', '...');     // eigen token i.p.v. de default
 *   // define('SMOKE_SITE_SLUG', 'eigen-slug');  // standaard afgeleid van de host
 *   // define('SMOKE_ENROLL_URL', '...');        // override enroll-functie-URL
 *   // define('SMOKE_NOTIFY_URL', '...');        // override notify-functie-URL
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

if ( ! function_exists( 'smoke_checks_secret' ) ) {
    function smoke_checks_secret(): string {
        return ( defined( 'SMOKE_ENROLL_SECRET' ) && SMOKE_ENROLL_SECRET )
            ? (string) SMOKE_ENROLL_SECRET
            : SMOKE_DEFAULT_ENROLL_TOKEN;
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

    $url = defined( 'SMOKE_ENROLL_URL' )
        ? SMOKE_ENROLL_URL
        : 'https://ncbzotjsefjunnnmgrgh.supabase.co/functions/v1/enroll-site';

    $resp = wp_remote_post( $url, [
        'timeout' => 15,
        'headers' => [
            'Content-Type'    => 'application/json',
            'x-enroll-secret' => smoke_checks_secret(),
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
 * Na een afgeronde plugin-, thema- of core-update: start een test-run (drift) voor deze site.
 * Zero-config: roept de notify-edge-function aan met het enroll-token; de GitHub-PAT
 * staat server-side. Debounce + actieve-site-check gebeuren in de edge function.
 */
add_action( 'upgrader_process_complete', function ( $upgrader, $options ): void {
    $type = $options['type'] ?? '';
    if ( ( $options['action'] ?? '' ) !== 'update' || ! in_array( $type, [ 'plugin', 'theme', 'core' ], true ) ) {
        return;
    }

    static $fired = false;
    if ( $fired ) {
        return;
    }
    $fired = true;

    $url = defined( 'SMOKE_NOTIFY_URL' )
        ? SMOKE_NOTIFY_URL
        : 'https://ncbzotjsefjunnnmgrgh.supabase.co/functions/v1/notify-update';

    $resp = wp_remote_post( $url, [
        'timeout' => 15,
        'headers' => [
            'Content-Type'    => 'application/json',
            'x-enroll-secret' => smoke_checks_secret(),
        ],
        'body' => wp_json_encode( [
            'site' => smoke_checks_slug(),
            'type' => $type,
        ] ),
    ] );

    if ( is_wp_error( $resp ) ) {
        error_log( '[smoke-checks] notify mislukt: ' . $resp->get_error_message() );
    }
}, 10, 2 );
