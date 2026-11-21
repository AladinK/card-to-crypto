<?php
/**
 * Minimal assertion helpers for the plain-PHP test scripts (no PHPUnit).
 *
 * @package CardCryptoGateway
 */

$GLOBALS['cc_test_results'] = array( 'passed' => 0, 'failed' => array() );

/**
 * Records one check. Prints a line for each result so the output can be read in CI logs.
 */
function cc_check( string $name, bool $ok, string $detail = '' ): void {
	if ( $ok ) {
		++$GLOBALS['cc_test_results']['passed'];
		echo "PASS  {$name}\n";
		return;
	}
	$GLOBALS['cc_test_results']['failed'][] = $name;
	echo "FAIL  {$name}" . ( '' !== $detail ? " -- {$detail}" : '' ) . "\n";
}

/**
 * Compares with strict equality and prints both values when they differ.
 */
function cc_same( string $name, $expected, $actual ): void {
	$ok = $expected === $actual;
	cc_check( $name, $ok, $ok ? '' : 'expected ' . var_export( $expected, true ) . ', got ' . var_export( $actual, true ) );
}

/**
 * Prints the summary and returns the process exit code (0 when every check passed).
 */
function cc_finish(): int {
	$passed = $GLOBALS['cc_test_results']['passed'];
	$failed = $GLOBALS['cc_test_results']['failed'];
	echo "\n" . ( $passed + count( $failed ) ) . ' checks: ' . $passed . ' passed, ' . count( $failed ) . " failed\n";
	return empty( $failed ) ? 0 : 1;
}
