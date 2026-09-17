export const metadata = {
  title: "Homely Tiffins",
  description: "Fresh, home-style meals — delivered within the society",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600;700;800;900&family=Dancing+Script:wght@600;700&family=Nunito:wght@400;600;700;800&display=swap"
          rel="stylesheet"
        />
        <link rel="icon" href="/logo.png" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#E0731A" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        {/* iOS ignores manifest.json's "standalone" display mode unless these
            are also set explicitly — without them some iOS versions open the
            home-screen icon as a regular Safari tab instead of full-screen. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Homely Tiffins" />
      </head>
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
