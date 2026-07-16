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
      </head>
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
