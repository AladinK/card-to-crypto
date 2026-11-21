<?php
/**
 * TEST HARNESS, NOT WORDPRESS.
 *
 * Minimal stand-ins for the WordPress and WooCommerce functions and classes the plugin calls, so the
 * gateway and webhook code can run under plain PHP. Behaviour is simplified on purpose, only as far as the
 * tests need. A passing run proves the plugin's own logic against these stand-ins; it does not prove
 * that WordPress or WooCommerce behave the same way. Run the plugin in a real WordPress and
 * WooCommerce site before relying on it.
 *
 * @package CardCryptoGateway
 */

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}

if ( ! defined( 'CARDCRYPTO_WC_VERSION' ) ) {
	define( 'CARDCRYPTO_WC_VERSION', '0.1.0' );
}

/** Resets every piece of fake global state. Called before each scenario. */
function cc_harness_reset(): void {
	$GLOBALS['cc'] = array(
		'options'          => array(),
		'transients'       => array(),
		'orders'           => array(),
		'notices'          => array(),
		'logs'             => array(),
		'transport'        => null,
		'redirects'        => array(),
		'currency'         => 'EUR',
		'fail_order_query' => false,
	);
}

cc_harness_reset();

final class WP_Error {
	public function __construct( private string $code = '', private string $message = '' ) {
	}

	public function get_error_code(): string {
		return $this->code;
	}

	public function get_error_message(): string {
		return $this->message;
	}
}

final class WP_REST_Request {
	/** @param array<string, string> $headers Lower-case names. */
	public function __construct( private array $headers = array() ) {
	}

	public function get_header( string $name ): ?string {
		return $this->headers[ strtolower( str_replace( '_', '-', $name ) ) ] ?? null;
	}
}

final class WP_REST_Response {
	public function __construct( public $data = null, public int $status = 200 ) {
	}
}

final class WP_REST_Server {
	public const CREATABLE = 'POST';
}

/** Records log entries instead of writing them to WooCommerce's log files. */
final class CcLogStub {
	public function log( $level, $message, $context = array() ): void {
		$GLOBALS['cc']['logs'][] = array( (string) $level, (string) $message, (array) $context );
	}
}

/**
 * Stand-in for WC_Order. Only the methods the plugin calls are implemented.
 * payment_complete() follows WooCommerce's rule: it works for on-hold, pending, failed and cancelled.
 */
class WC_Order {
	/** @var array<string, mixed> */
	private array $meta = array();
	/** @var list<string> */
	public array $notes = array();
	public int $saves = 0;
	public int $completions = 0;
	private string $transaction_id = '';

	public function __construct(
		private int $id,
		private string $total,
		private string $currency,
		private string $status,
		private string $billing_email = 'buyer@example.com'
	) {
	}

	public function get_id(): int {
		return $this->id;
	}

	public function get_order_number(): string {
		return (string) $this->id;
	}

	public function get_total(): string {
		return $this->total;
	}

	public function set_total( string $total ): void {
		$this->total = $total;
	}

	public function get_currency(): string {
		return $this->currency;
	}

	public function get_status(): string {
		return $this->status;
	}

	public function get_billing_email(): string {
		return $this->billing_email;
	}

	public function get_payment_method(): string {
		return 'cardcrypto';
	}

	public function get_meta( string $key = '', bool $single = true ) {
		return $this->meta[ $key ] ?? '';
	}

	public function update_meta_data( string $key, $value ): void {
		$this->meta[ $key ] = $value;
	}

	public function save(): int {
		++$this->saves;
		return $this->id;
	}

	public function get_transaction_id(): string {
		return $this->transaction_id;
	}

	public function payment_complete( string $transaction_id = '' ): bool {
		if ( ! in_array( $this->status, array( 'on-hold', 'pending', 'failed', 'cancelled' ), true ) ) {
			return false;
		}

		if ( '' !== $transaction_id ) {
			$this->transaction_id = $transaction_id;
		}

		$this->status = 'processing';
		++$this->completions;
		$this->save();

		return true;
	}

	public function update_status( string $status, string $note = '' ): bool {
		$this->status = $status;
		if ( '' !== $note ) {
			$this->notes[] = $note;
		}
		$this->save();

		return true;
	}

	public function add_order_note( string $note ): void {
		$this->notes[] = $note;
	}

	public function get_cancel_order_url_raw( string $redirect = '' ): string {
		return 'https://shop.example/cart/?cancel_order=true&order_id=' . $this->id . '&_wpnonce=test-cancel';
	}
}

/** Stand-in for WooCommerce's gateway base class. The real one lives in WooCommerce core. */
class WC_Payment_Gateway {
	public $id                 = '';
	public $icon               = '';
	public $has_fields         = false;
	public $method_title       = '';
	public $method_description = '';
	public $supports           = array();
	public $form_fields        = array();
	public $settings           = array();
	public $enabled            = 'no';
	public $title              = '';
	public $description        = '';

	public function init_form_fields() {
	}

	public function init_settings() {
		$this->settings = get_option( 'woocommerce_' . $this->id . '_settings', array() );
		$this->enabled  = ( ! empty( $this->settings['enabled'] ) && 'yes' === $this->settings['enabled'] ) ? 'yes' : 'no';
	}

	public function get_option( $key, $empty_value = null ) {
		return $this->settings[ $key ] ?? $empty_value;
	}

	public function get_field_key( $key ) {
		return 'woocommerce_' . $this->id . '_' . $key;
	}

	public function get_tooltip_html( $data ) {
		return '';
	}

	public function get_description_html( $data ) {
		return empty( $data['description'] ) ? '' : '<p class="description">' . $data['description'] . '</p>';
	}

	public function admin_options() {
	}

	public function get_description() {
		return $this->description;
	}

	public function get_return_url( $order = null ) {
		return 'https://shop.example/checkout/order-received/' . $order->get_id() . '/?key=wc_order_test';
	}

	public function is_available() {
		return 'yes' === $this->enabled;
	}

	public function needs_setup() {
		return false;
	}

	public function process_admin_options() {
		return true;
	}
}

// ---------------------------------------------------------------------------
// WordPress functions (behaviour reduced to what the tests need)
// ---------------------------------------------------------------------------

function __( $text, $domain = 'default' ) {
	return $text;
}

function esc_html__( $text, $domain = 'default' ) {
	return htmlspecialchars( (string) $text, ENT_QUOTES );
}

function esc_html_e( $text, $domain = 'default' ) {
	echo esc_html__( $text, $domain );
}

function esc_html( $text ) {
	return htmlspecialchars( (string) $text, ENT_QUOTES );
}

function esc_attr( $text ) {
	return htmlspecialchars( (string) $text, ENT_QUOTES );
}

function esc_url( $url ) {
	return htmlspecialchars( (string) $url, ENT_QUOTES );
}

function wp_kses_post( $text ) {
	return (string) $text;
}

function wpautop( $text ) {
	return '<p>' . $text . '</p>';
}

function wptexturize( $text ) {
	return $text;
}

function sanitize_text_field( $text ) {
	return trim( strip_tags( (string) $text ) );
}

function sanitize_key( $key ) {
	return strtolower( (string) preg_replace( '/[^a-z0-9_\-]/i', '', (string) $key ) );
}

function wp_unslash( $value ) {
	return $value;
}

function wp_parse_args( $args, $defaults ) {
	return array_merge( $defaults, (array) $args );
}

function is_email( $email ) {
	return 1 === preg_match( '/^[^@\s]+@[^@\s]+\.[^@\s]+$/', (string) $email );
}

function disabled( $disabled, $current = true, $echo = true ) {
	$result = $disabled === $current ? "disabled='disabled'" : '';
	if ( $echo ) {
		echo $result;
	}

	return $result;
}

function get_option( $name, $default = false ) {
	return $GLOBALS['cc']['options'][ $name ] ?? $default;
}

function update_option( $name, $value, $autoload = null ) {
	$GLOBALS['cc']['options'][ $name ] = $value;

	return true;
}

function set_transient( $name, $value, $ttl = 0 ) {
	$GLOBALS['cc']['transients'][ $name ] = $value;

	return true;
}

function get_transient( $name ) {
	return $GLOBALS['cc']['transients'][ $name ] ?? false;
}

function delete_transient( $name ) {
	unset( $GLOBALS['cc']['transients'][ $name ] );

	return true;
}

function get_current_user_id() {
	return 1;
}

function current_user_can( $capability ) {
	return true;
}

function admin_url( $path = '' ) {
	return 'https://shop.example/wp-admin/' . ltrim( (string) $path, '/' );
}

function rest_url( $path = '' ) {
	return 'https://shop.example/wp-json/' . ltrim( (string) $path, '/' );
}

function wp_nonce_url( $url, $action = -1 ) {
	return $url . '&_wpnonce=test-nonce';
}

function check_admin_referer( $action = -1, $query_arg = '_wpnonce' ) {
	return 1;
}

function wp_safe_redirect( $location, $status = 302 ) {
	$GLOBALS['cc']['redirects'][] = (string) $location;
}

function wp_die( $message = '', $title = '', $args = array() ) {
	throw new RuntimeException( 'wp_die: ' . $message );
}

function add_action( ...$args ) {
	return true;
}

function add_filter( ...$args ) {
	return true;
}

function register_rest_route( ...$args ) {
	return true;
}

function plugin_basename( $file ) {
	return 'card-to-crypto-gateway/' . basename( (string) $file );
}

// ---------------------------------------------------------------------------
// WooCommerce functions
// ---------------------------------------------------------------------------

/**
 * Stand-in only. WooCommerce's real wc_format_decimal() also strips locale separators and trims zeros
 * when asked; this version covers the call the plugin makes: wc_format_decimal( $total, 2 ).
 */
function wc_format_decimal( $number, $dp = false, $trim_zeros = false ) {
	return number_format( (float) $number, (int) $dp, '.', '' );
}

function get_woocommerce_currency() {
	return $GLOBALS['cc']['currency'];
}

function wc_get_order( $order_id ) {
	return $GLOBALS['cc']['orders'][ (int) $order_id ] ?? false;
}

/** Honours the meta_key / meta_value and payment_method arguments the plugin uses. */
function wc_get_orders( $args ) {
	if ( ! empty( $GLOBALS['cc']['fail_order_query'] ) ) {
		throw new RuntimeException( 'simulated database failure' );
	}

	$found = array();
	foreach ( $GLOBALS['cc']['orders'] as $order ) {
		if ( isset( $args['payment_method'] ) && $order->get_payment_method() !== $args['payment_method'] ) {
			continue;
		}
		if ( isset( $args['meta_key'] ) && (string) $order->get_meta( $args['meta_key'] ) !== (string) $args['meta_value'] ) {
			continue;
		}
		$found[] = $order;
	}

	return array_slice( $found, 0, (int) ( $args['limit'] ?? count( $found ) ) );
}

function wc_add_notice( $message, $notice_type = 'success', $data = array() ) {
	$GLOBALS['cc']['notices'][] = array( (string) $notice_type, (string) $message );
}

function wc_get_logger() {
	return new CcLogStub();
}

// ---------------------------------------------------------------------------
// HTTP API (the test seam). wp_remote_request() hands the call to the fake backend.
// ---------------------------------------------------------------------------

function wp_remote_request( $url, $args = array() ) {
	$transport = $GLOBALS['cc']['transport'];
	if ( null === $transport ) {
		return new WP_Error( 'no_transport', 'No fake transport is configured.' );
	}

	return $transport( (string) $url, (array) $args );
}

function is_wp_error( $thing ) {
	return $thing instanceof WP_Error;
}

function wp_remote_retrieve_response_code( $response ) {
	return $response['response']['code'] ?? '';
}

function wp_remote_retrieve_body( $response ) {
	return $response['body'] ?? '';
}
