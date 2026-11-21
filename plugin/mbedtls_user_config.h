/* DownBeat (Windows builds): mbedTLS user config.
 * TLS 1.2 only: the mbedTLS 3.6 TLS 1.3 client fails its handshake with Google Cloud Run
 * ("SSL - Internal error"); TLS 1.2 connects fine. */
#undef MBEDTLS_SSL_PROTO_TLS1_3
#undef MBEDTLS_SSL_TLS1_3_COMPATIBILITY_MODE
