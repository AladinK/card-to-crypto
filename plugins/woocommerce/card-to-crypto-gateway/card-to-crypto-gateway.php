<?php
/**
 * Plugin Name:       Card-to-Crypto Gateway for WooCommerce
 * Description:       Accept card payments in WooCommerce. Customers see a normal card checkout; the merchant receives USDC or USDT in their own wallet.
 * Version:           0.1.0
 * Requires at least: 6.5
 * Requires PHP:      8.1
 * Requires Plugins:  woocommerce
 * WC requires at least: 8.0
 * Author:            Card-to-Crypto
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       card-to-crypto-gateway
 *
 * @package CardCryptoGateway
 */

defined( 'ABSPATH' ) || exit;

define( 'CARDCRYPTO_WC_VERSION', '0.1.0' );

require_once __DIR__ . '/includes/class-cardcrypto-signature.php';
require_once __DIR__ . '/includes/class-cardcrypto-logger.php';
require_once __DIR__ . '/includes/class-cardcrypto-api-exception.php';
require_once __DIR__ . '/includes/class-cardcrypto-api.php';
require_once __DIR__ . '/includes/class-cardcrypto-webhook.php';

register_activation_hook( __FILE__, 'cardcrypto_wc_activate' );
add_action( 'before_woocommerce_init', 'cardcrypto_wc_declare_hpos_compatibility' );
add_action( 'plugins_loaded', 'cardcrypto_wc_bootstrap', 11 );
add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), 'cardcrypto_wc_action_links' );

/**
 * Refuses to activate without WooCommerce. WordPress 6.5+ also enforces "Requires Plugins".
 */
function cardcrypto_wc_activate(): void {
	if ( class_exists( 'WooCommerce' ) ) {
		return;
	}

	deactivate_plugins( plugin_basename( __FILE__ ) );
	wp_die(
		esc_html__( 'Card-to-Crypto Gateway needs WooCommerce to be installed and active.', 'card-to-crypto-gateway' ),
		esc_html__( 'Plugin activation failed', 'card-to-crypto-gateway' ),
		array( 'back_link' => true )
	);
}

/**
 * Declares support for WooCommerce High-Performance Order Storage. The plugin only uses the
 * order API (get_meta, update_meta_data, save), so it works with either storage.
 */
function cardcrypto_wc_declare_hpos_compatibility(): void {
	if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
	}
}

/**
 * Registers the gateway, the webhook route and the connection-test handlers once WooCommerce is loaded.
 */
function cardcrypto_wc_bootstrap(): void {
	if ( ! class_exists( 'WooCommerce' ) ) {
		add_action( 'admin_notices', 'cardcrypto_wc_missing_woocommerce_notice' );
		return;
	}

	require_once __DIR__ . '/includes/class-wc-gateway-cardcrypto.php';

	add_filter( 'woocommerce_payment_gateways', 'cardcrypto_wc_register_gateway' );
	add_action( 'rest_api_init', array( 'CardCrypto_Webhook', 'register_route' ) );
	add_action( 'admin_post_cardcrypto_test_connection', array( 'WC_Gateway_CardCrypto', 'handle_test_connection' ) );
	add_action( 'admin_notices', array( 'WC_Gateway_CardCrypto', 'render_test_notice' ) );
}

/**
 * Adds the gateway class to WooCommerce's list of payment gateways.
 *
 * @param array<int, string> $gateways Gateway class names.
 * @return array<int, string>
 */
function cardcrypto_wc_register_gateway( array $gateways ): array {
	$gateways[] = 'WC_Gateway_CardCrypto';

	return $gateways;
}

/**
 * Admin notice shown when WooCommerce is not active.
 */
function cardcrypto_wc_missing_woocommerce_notice(): void {
	if ( ! current_user_can( 'activate_plugins' ) ) {
		return;
	}

	printf(
		'<div class="notice notice-error"><p>%s</p></div>',
		esc_html__( 'Card-to-Crypto Gateway needs WooCommerce to be installed and active.', 'card-to-crypto-gateway' )
	);
}

/**
 * Adds a Settings link to the plugin's row on the Plugins screen.
 *
 * @param array<int, string> $links Existing action links.
 * @return array<int, string>
 */
function cardcrypto_wc_action_links( array $links ): array {
	$settings_url = admin_url( 'admin.php?page=wc-settings&tab=checkout&section=cardcrypto' );

	array_unshift( $links, '<a href="' . esc_url( $settings_url ) . '">' . esc_html__( 'Settings', 'card-to-crypto-gateway' ) . '</a>' );

	return $links;
}
