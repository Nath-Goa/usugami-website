// Character encodings of simple PDF fonts and glyph names to Unicode, for drawing form field
// text in a form's own font. Data: the standard encodings of the PDF specification (Annex D) and
// the Adobe Glyph List (BSD-3-Clause), Latin, Greek, Cyrillic and common symbols only.
// Generated once from the tables pdf.js carries; '-' marks a code with no glyph.

const table = (s) => s.split(' ').map((n) => (n === '-' ? '' : n));

export const STANDARD = table(
  '- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - space exclam quotedbl numbersign ' +
  'dollar percent ampersand quoteright parenleft parenright asterisk plus comma hyphen period slash ' +
  'zero one two three four five six seven eight nine colon semicolon less equal greater question at ' +
  'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright ' +
  'asciicircum underscore quoteleft a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft ' +
  'bar braceright asciitilde - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - ' +
  'exclamdown cent sterling fraction yen florin section currency quotesingle quotedblleft ' +
  'guillemotleft guilsinglleft guilsinglright fi fl - endash dagger daggerdbl periodcentered - ' +
  'paragraph bullet quotesinglbase quotedblbase quotedblright guillemotright ellipsis perthousand - ' +
  'questiondown - grave acute circumflex tilde macron breve dotaccent dieresis - ring cedilla - ' +
  'hungarumlaut ogonek caron emdash - - - - - - - - - - - - - - - - AE - ordfeminine - - - - Lslash ' +
  'Oslash OE ordmasculine - - - - - ae - - - dotlessi - - lslash oslash oe germandbls - - - -' +
  '');

export const MAC_ROMAN = table(
  '- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - space exclam quotedbl numbersign ' +
  'dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period ' +
  'slash zero one two three four five six seven eight nine colon semicolon less equal greater ' +
  'question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash ' +
  'bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z ' +
  'braceleft bar braceright asciitilde - Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis ' +
  'aacute agrave acircumflex adieresis atilde aring ccedilla eacute egrave ecircumflex edieresis ' +
  'iacute igrave icircumflex idieresis ntilde oacute ograve ocircumflex odieresis otilde uacute ' +
  'ugrave ucircumflex udieresis dagger degree cent sterling section bullet paragraph germandbls ' +
  'registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus lessequal ' +
  'greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae ' +
  'oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft ' +
  'guillemotright ellipsis space Agrave Atilde Otilde OE oe endash emdash quotedblleft ' +
  'quotedblright quoteleft quoteright divide lozenge ydieresis Ydieresis fraction currency ' +
  'guilsinglleft guilsinglright fi fl daggerdbl periodcentered quotesinglbase quotedblbase ' +
  'perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex Idieresis Igrave ' +
  'Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron breve ' +
  'dotaccent ring cedilla hungarumlaut ogonek caron' +
  '');

export const WIN_ANSI = table(
  '- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - space exclam quotedbl numbersign ' +
  'dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period ' +
  'slash zero one two three four five six seven eight nine colon semicolon less equal greater ' +
  'question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash ' +
  'bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z ' +
  'braceleft bar braceright asciitilde bullet Euro bullet quotesinglbase florin quotedblbase ' +
  'ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE bullet Zcaron bullet ' +
  'bullet quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde trademark ' +
  'scaron guilsinglright oe bullet zcaron Ydieresis space exclamdown cent sterling currency yen ' +
  'brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered ' +
  'macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla ' +
  'onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave ' +
  'Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave ' +
  'Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply ' +
  'Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex ' +
  'atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex ' +
  'idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ' +
  'ucircumflex udieresis yacute thorn ydieresis' +
  '');

export const SYMBOL = table(
  '- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - space exclam universal ' +
  'numbersign existential percent ampersand suchthat parenleft parenright asteriskmath plus comma ' +
  'minus period slash zero one two three four five six seven eight nine colon semicolon less equal ' +
  'greater question congruent Alpha Beta Chi Delta Epsilon Phi Gamma Eta Iota theta1 Kappa Lambda ' +
  'Mu Nu Omicron Pi Theta Rho Sigma Tau Upsilon sigma1 Omega Xi Psi Zeta bracketleft therefore ' +
  'bracketright perpendicular underscore radicalex alpha beta chi delta epsilon phi gamma eta iota ' +
  'phi1 kappa lambda mu nu omicron pi theta rho sigma tau upsilon omega1 omega xi psi zeta ' +
  'braceleft bar braceright similar - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - ' +
  '- Euro Upsilon1 minute lessequal fraction infinity florin club diamond heart spade arrowboth ' +
  'arrowleft arrowup arrowright arrowdown degree plusminus second greaterequal multiply ' +
  'proportional partialdiff bullet divide notequal equivalence approxequal ellipsis arrowvertex ' +
  'arrowhorizex carriagereturn aleph Ifraktur Rfraktur weierstrass circlemultiply circleplus ' +
  'emptyset intersection union propersuperset reflexsuperset notsubset propersubset reflexsubset ' +
  'element notelement angle gradient registerserif copyrightserif trademarkserif product radical ' +
  'dotmath logicalnot logicaland logicalor arrowdblboth arrowdblleft arrowdblup arrowdblright ' +
  'arrowdbldown lozenge angleleft registersans copyrightsans trademarksans summation parenlefttp ' +
  'parenleftex parenleftbt bracketlefttp bracketleftex bracketleftbt bracelefttp braceleftmid ' +
  'braceleftbt braceex - angleright integral integraltp integralex integralbt parenrighttp ' +
  'parenrightex parenrightbt bracketrighttp bracketrightex bracketrightbt bracerighttp ' +
  'bracerightmid bracerightbt -' +
  '');

export const ZAPF_DINGBATS = table(
  '- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - space a1 a2 a202 a3 a4 a5 a119 ' +
  'a118 a117 a11 a12 a13 a14 a15 a16 a105 a17 a18 a19 a20 a21 a22 a23 a24 a25 a26 a27 a28 a6 a7 a8 ' +
  'a9 a10 a29 a30 a31 a32 a33 a34 a35 a36 a37 a38 a39 a40 a41 a42 a43 a44 a45 a46 a47 a48 a49 a50 ' +
  'a51 a52 a53 a54 a55 a56 a57 a58 a59 a60 a61 a62 a63 a64 a65 a66 a67 a68 a69 a70 a71 a72 a73 a74 ' +
  'a203 a75 a204 a76 a77 a78 a79 a81 a82 a83 a84 a97 a98 a99 a100 - a89 a90 a93 a94 a91 a92 a205 ' +
  'a85 a206 a86 a87 a88 a95 a96 - - - - - - - - - - - - - - - - - - - a101 a102 a103 a104 a106 a107 ' +
  'a108 a112 a111 a110 a109 a120 a121 a122 a123 a124 a125 a126 a127 a128 a129 a130 a131 a132 a133 ' +
  'a134 a135 a136 a137 a138 a139 a140 a141 a142 a143 a144 a145 a146 a147 a148 a149 a150 a151 a152 ' +
  'a153 a154 a155 a156 a157 a158 a159 a160 a161 a163 a164 a196 a165 a192 a166 a167 a168 a169 a170 ' +
  'a171 a172 a173 a162 a174 a175 a176 a177 a178 a179 a193 a180 a199 a181 a200 a182 - a201 a183 a184 ' +
  'a197 a185 a194 a198 a186 a195 a187 a188 a189 a190 a191 -' +
  '');

const GLYPH_LIST =
  'A 41 AE c6 AEacute 1fc AEmacron 1e2 Aacute c1 Abreve 102 Abreveacute 1eae Abrevecyrillic 4d0 ' +
  'Abrevedotbelow 1eb6 Abrevegrave 1eb0 Abrevehookabove 1eb2 Abrevetilde 1eb4 Acaron 1cd ' +
  'Acircumflex c2 Acircumflexacute 1ea4 Acircumflexdotbelow 1eac Acircumflexgrave 1ea6 ' +
  'Acircumflexhookabove 1ea8 Acircumflextilde 1eaa Acyrillic 410 Adblgrave 200 Adieresis c4 ' +
  'Adieresiscyrillic 4d2 Adieresismacron 1de Adotbelow 1ea0 Adotmacron 1e0 Agrave c0 Ahookabove ' +
  '1ea2 Aiecyrillic 4d4 Ainvertedbreve 202 Alpha 391 Alphatonos 386 Amacron 100 Aogonek 104 Aring ' +
  'c5 Aringacute 1fa Aringbelow 1e00 Atilde c3 Aybarmenian 531 B 42 Bdotaccent 1e02 Bdotbelow 1e04 ' +
  'Becyrillic 411 Benarmenian 532 Beta 392 Bhook 181 Blinebelow 1e06 Btopbar 182 C 43 Caarmenian ' +
  '53e Cacute 106 Ccaron 10c Ccedilla c7 Ccedillaacute 1e08 Ccircumflex 108 Cdot 10a Cdotaccent 10a ' +
  'Chaarmenian 549 Cheabkhasiancyrillic 4bc Checyrillic 427 Chedescenderabkhasiancyrillic 4be ' +
  'Chedescendercyrillic 4b6 Chedieresiscyrillic 4f4 Cheharmenian 543 Chekhakassiancyrillic 4cb ' +
  'Cheverticalstrokecyrillic 4b8 Chi 3a7 Chook 187 Coarmenian 551 D 44 DZ 1f1 DZcaron 1c4 ' +
  'Daarmenian 534 Dafrican 189 Dcaron 10e Dcedilla 1e10 Dcircumflexbelow 1e12 Dcroat 110 Ddotaccent ' +
  '1e0a Ddotbelow 1e0c Decyrillic 414 Deicoptic 3ee Delta 2206 Deltagreek 394 Dhook 18a ' +
  'Digammagreek 3dc Djecyrillic 402 Dlinebelow 1e0e Dslash 110 Dtopbar 18b Dz 1f2 Dzcaron 1c5 ' +
  'Dzeabkhasiancyrillic 4e0 Dzecyrillic 405 Dzhecyrillic 40f E 45 Eacute c9 Ebreve 114 Ecaron 11a ' +
  'Ecedillabreve 1e1c Echarmenian 535 Ecircumflex ca Ecircumflexacute 1ebe Ecircumflexbelow 1e18 ' +
  'Ecircumflexdotbelow 1ec6 Ecircumflexgrave 1ec0 Ecircumflexhookabove 1ec2 Ecircumflextilde 1ec4 ' +
  'Ecyrillic 404 Edblgrave 204 Edieresis cb Edot 116 Edotaccent 116 Edotbelow 1eb8 Efcyrillic 424 ' +
  'Egrave c8 Eharmenian 537 Ehookabove 1eba Eightroman 2167 Einvertedbreve 206 Eiotifiedcyrillic ' +
  '464 Elcyrillic 41b Elevenroman 216a Emacron 112 Emacronacute 1e16 Emacrongrave 1e14 Emcyrillic ' +
  '41c Encyrillic 41d Endescendercyrillic 4a2 Eng 14a Enghecyrillic 4a4 Enhookcyrillic 4c7 Eogonek ' +
  '118 Eopen 190 Epsilon 395 Epsilontonos 388 Ercyrillic 420 Ereversed 18e Ereversedcyrillic 42d ' +
  'Escyrillic 421 Esdescendercyrillic 4aa Esh 1a9 Eta 397 Etarmenian 538 Etatonos 389 Eth d0 Etilde ' +
  '1ebc Etildebelow 1e1a Euro 20ac Ezh 1b7 Ezhcaron 1ee Ezhreversed 1b8 F 46 Fdotaccent 1e1e ' +
  'Feharmenian 556 Feicoptic 3e4 Fhook 191 Fitacyrillic 472 Fiveroman 2164 Fourroman 2163 G 47 ' +
  'Gacute 1f4 Gamma 393 Gammaafrican 194 Gangiacoptic 3ea Gbreve 11e Gcaron 1e6 Gcedilla 122 ' +
  'Gcircumflex 11c Gcommaaccent 122 Gdot 120 Gdotaccent 120 Gecyrillic 413 Ghadarmenian 542 ' +
  'Ghemiddlehookcyrillic 494 Ghestrokecyrillic 492 Gheupturncyrillic 490 Ghook 193 Gimarmenian 533 ' +
  'Gjecyrillic 403 Gmacron 1e20 Gsmallhook 29b Gstroke 1e4 H 48 H18533 25cf H18543 25aa H18551 25ab ' +
  'H22073 25a1 Haabkhasiancyrillic 4a8 Hadescendercyrillic 4b2 Hardsigncyrillic 42a Hbar 126 ' +
  'Hbrevebelow 1e2a Hcedilla 1e28 Hcircumflex 124 Hdieresis 1e26 Hdotaccent 1e22 Hdotbelow 1e24 ' +
  'Hoarmenian 540 Horicoptic 1 I 49 IAcyrillic 42f IJ 132 IUcyrillic 42e Iacute cd Ibreve 12c ' +
  'Icaron 1cf Icircumflex ce Icyrillic 406 Idblgrave 208 Idieresis cf Idieresisacute 1e2e ' +
  'Idieresiscyrillic 4e4 Idot 130 Idotaccent 130 Idotbelow 1eca Iebrevecyrillic 4d6 Iecyrillic 415 ' +
  'Ifraktur 2111 Igrave cc Ihookabove 1ec8 Iicyrillic 418 Iinvertedbreve 20a Iishortcyrillic 419 ' +
  'Imacron 12a Imacroncyrillic 4e2 Iniarmenian 53b Iocyrillic 401 Iogonek 12e Iota 399 Iotaafrican ' +
  '196 Iotadieresis 3aa Iotatonos 38a Istroke 197 Itilde 128 Itildebelow 1e2c Izhitsacyrillic 474 ' +
  'Izhitsadblgravecyrillic 476 J 4a Jaarmenian 541 Jcircumflex 134 Jecyrillic 408 Jheharmenian 54b ' +
  'K 4b Kabashkircyrillic 4a0 Kacute 1e30 Kacyrillic 41a Kadescendercyrillic 49a Kahookcyrillic 4c3 ' +
  'Kappa 39a Kastrokecyrillic 49e Kaverticalstrokecyrillic 49c Kcaron 1e8 Kcedilla 136 Kcommaaccent ' +
  '136 Kdotbelow 1e32 Keharmenian 554 Kenarmenian 53f Khacyrillic 425 Kheicoptic 3e6 Khook 198 ' +
  'Kjecyrillic 40c Klinebelow 1e34 Koppacyrillic 480 Koppagreek 3de Ksicyrillic 46e L 4c LJ 1c7 ' +
  'Lacute 139 Lambda 39b Lcaron 13d Lcedilla 13b Lcircumflexbelow 1e3c Lcommaaccent 13b Ldot 13f ' +
  'Ldotaccent 13f Ldotbelow 1e36 Ldotbelowmacron 1e38 Liwnarmenian 53c Lj 1c8 Ljecyrillic 409 ' +
  'Llinebelow 1e3a Lslash 141 M 4d Macute 1e3e Mdotaccent 1e40 Mdotbelow 1e42 Menarmenian 544 ' +
  'Mturned 19c Mu 39c N 4e NJ 1ca Nacute 143 Ncaron 147 Ncedilla 145 Ncircumflexbelow 1e4a ' +
  'Ncommaaccent 145 Ndotaccent 1e44 Ndotbelow 1e46 Nhookleft 19d Nineroman 2168 Nj 1cb Njecyrillic ' +
  '40a Nlinebelow 1e48 Nowarmenian 546 Ntilde d1 Nu 39d O 4f OE 152 Oacute d3 Obarredcyrillic 4e8 ' +
  'Obarreddieresiscyrillic 4ea Obreve 14e Ocaron 1d1 Ocenteredtilde 19f Ocircumflex d4 ' +
  'Ocircumflexacute 1ed0 Ocircumflexdotbelow 1ed8 Ocircumflexgrave 1ed2 Ocircumflexhookabove 1ed4 ' +
  'Ocircumflextilde 1ed6 Ocyrillic 41e Odblacute 150 Odblgrave 20c Odieresis d6 Odieresiscyrillic ' +
  '4e6 Odotbelow 1ecc Ograve d2 Oharmenian 555 Ohm 2126 Ohookabove 1ece Ohorn 1a0 Ohornacute 1eda ' +
  'Ohorndotbelow 1ee2 Ohorngrave 1edc Ohornhookabove 1ede Ohorntilde 1ee0 Ohungarumlaut 150 Oi 1a2 ' +
  'Oinvertedbreve 20e Omacron 14c Omacronacute 1e52 Omacrongrave 1e50 Omega 2126 Omegacyrillic 460 ' +
  'Omegagreek 3a9 Omegaroundcyrillic 47a Omegatitlocyrillic 47c Omegatonos 38f Omicron 39f ' +
  'Omicrontonos 38c Oneroman 2160 Oogonek 1ea Oogonekmacron 1ec Oopen 186 Oslash d8 Oslashacute 1fe ' +
  'Ostrokeacute 1fe Otcyrillic 47e Otilde d5 Otildeacute 1e4c Otildedieresis 1e4e P 50 Pacute 1e54 ' +
  'Pdotaccent 1e56 Pecyrillic 41f Peharmenian 54a Pemiddlehookcyrillic 4a6 Phi 3a6 Phook 1a4 Pi 3a0 ' +
  'Piwrarmenian 553 Psi 3a8 Psicyrillic 470 Q 51 R 52 Raarmenian 54c Racute 154 Rcaron 158 Rcedilla ' +
  '156 Rcommaaccent 156 Rdblgrave 210 Rdotaccent 1e58 Rdotbelow 1e5a Rdotbelowmacron 1e5c ' +
  'Reharmenian 550 Rfraktur 211c Rho 3a1 Rinvertedbreve 212 Rlinebelow 1e5e Rsmallinverted 281 ' +
  'Rsmallinvertedsuperior 2b6 S 53 Sacute 15a Sacutedotaccent 1e64 Sampigreek 3e0 Scaron 160 ' +
  'Scarondotaccent 1e66 Scedilla 15e Schwa 18f Schwacyrillic 4d8 Schwadieresiscyrillic 4da ' +
  'Scircumflex 15c Scommaaccent 218 Sdotaccent 1e60 Sdotbelow 1e62 Sdotbelowdotaccent 1e68 ' +
  'Seharmenian 54d Sevenroman 2166 Shaarmenian 547 Shacyrillic 428 Shchacyrillic 429 Sheicoptic 3e2 ' +
  'Shhacyrillic 4ba Shimacoptic 3ec Sigma 3a3 Sixroman 2165 Softsigncyrillic 42c Stigmagreek 3da T ' +
  '54 Tau 3a4 Tbar 166 Tcaron 164 Tcedilla 162 Tcircumflexbelow 1e70 Tcommaaccent 162 Tdotaccent ' +
  '1e6a Tdotbelow 1e6c Tecyrillic 422 Tedescendercyrillic 4ac Tenroman 2169 Tetsecyrillic 4b4 Theta ' +
  '398 Thook 1ac Thorn de Threeroman 2162 Tiwnarmenian 54f Tlinebelow 1e6e Toarmenian 539 Tonefive ' +
  '1bc Tonesix 184 Tonetwo 1a7 Tretroflexhook 1ae Tsecyrillic 426 Tshecyrillic 40b Twelveroman 216b ' +
  'Tworoman 2161 U 55 Uacute da Ubreve 16c Ucaron 1d3 Ucircumflex db Ucircumflexbelow 1e76 ' +
  'Ucyrillic 423 Udblacute 170 Udblgrave 214 Udieresis dc Udieresisacute 1d7 Udieresisbelow 1e72 ' +
  'Udieresiscaron 1d9 Udieresiscyrillic 4f0 Udieresisgrave 1db Udieresismacron 1d5 Udotbelow 1ee4 ' +
  'Ugrave d9 Uhookabove 1ee6 Uhorn 1af Uhornacute 1ee8 Uhorndotbelow 1ef0 Uhorngrave 1eea ' +
  'Uhornhookabove 1eec Uhorntilde 1eee Uhungarumlaut 170 Uhungarumlautcyrillic 4f2 Uinvertedbreve ' +
  '216 Ukcyrillic 478 Umacron 16a Umacroncyrillic 4ee Umacrondieresis 1e7a Uogonek 172 Upsilon 3a5 ' +
  'Upsilon1 3d2 Upsilonacutehooksymbolgreek 3d3 Upsilonafrican 1b1 Upsilondieresis 3ab ' +
  'Upsilondieresishooksymbolgreek 3d4 Upsilonhooksymbol 3d2 Upsilontonos 38e Uring 16e ' +
  'Ushortcyrillic 40e Ustraightcyrillic 4ae Ustraightstrokecyrillic 4b0 Utilde 168 Utildeacute 1e78 ' +
  'Utildebelow 1e74 V 56 Vdotbelow 1e7e Vecyrillic 412 Vewarmenian 54e Vhook 1b2 Voarmenian 548 ' +
  'Vtilde 1e7c W 57 Wacute 1e82 Wcircumflex 174 Wdieresis 1e84 Wdotaccent 1e86 Wdotbelow 1e88 ' +
  'Wgrave 1e80 X 58 Xdieresis 1e8c Xdotaccent 1e8a Xeharmenian 53d Xi 39e Y 59 Yacute dd ' +
  'Yatcyrillic 462 Ycircumflex 176 Ydieresis 178 Ydotaccent 1e8e Ydotbelow 1ef4 Yericyrillic 42b ' +
  'Yerudieresiscyrillic 4f8 Ygrave 1ef2 Yhook 1b3 Yhookabove 1ef6 Yiarmenian 545 Yicyrillic 407 ' +
  'Yiwnarmenian 552 Ytilde 1ef8 Yusbigcyrillic 46a Yusbigiotifiedcyrillic 46c Yuslittlecyrillic 466 ' +
  'Yuslittleiotifiedcyrillic 468 Z 5a Zaarmenian 536 Zacute 179 Zcaron 17d Zcircumflex 1e90 Zdot ' +
  '17b Zdotaccent 17b Zdotbelow 1e92 Zecyrillic 417 Zedescendercyrillic 498 Zedieresiscyrillic 4de ' +
  'Zeta 396 Zhearmenian 53a Zhebrevecyrillic 4c1 Zhecyrillic 416 Zhedescendercyrillic 496 ' +
  'Zhedieresiscyrillic 4dc Zlinebelow 1e94 Zstroke 1b5 a 61 aacute e1 abbreviationmarkarmenian 55f ' +
  'abreve 103 abreveacute 1eaf abrevecyrillic 4d1 abrevedotbelow 1eb7 abrevegrave 1eb1 ' +
  'abrevehookabove 1eb3 abrevetilde 1eb5 acaron 1ce acircumflex e2 acircumflexacute 1ea5 ' +
  'acircumflexdotbelow 1ead acircumflexgrave 1ea7 acircumflexhookabove 1ea9 acircumflextilde 1eab ' +
  'acute b4 acutebelowcmb 317 acutecmb 301 acutecomb 301 acutelowmod 2cf acutetonecmb 341 acyrillic ' +
  '430 adblgrave 201 adieresis e4 adieresiscyrillic 4d3 adieresismacron 1df adotbelow 1ea1 ' +
  'adotmacron 1e1 ae e6 aeacute 1fd aemacron 1e3 afii00208 2015 afii08941 20a4 afii10017 410 ' +
  'afii10018 411 afii10019 412 afii10020 413 afii10021 414 afii10022 415 afii10023 401 afii10024 ' +
  '416 afii10025 417 afii10026 418 afii10027 419 afii10028 41a afii10029 41b afii10030 41c ' +
  'afii10031 41d afii10032 41e afii10033 41f afii10034 420 afii10035 421 afii10036 422 afii10037 ' +
  '423 afii10038 424 afii10039 425 afii10040 426 afii10041 427 afii10042 428 afii10043 429 ' +
  'afii10044 42a afii10045 42b afii10046 42c afii10047 42d afii10048 42e afii10049 42f afii10050 ' +
  '490 afii10051 402 afii10052 403 afii10053 404 afii10054 405 afii10055 406 afii10056 407 ' +
  'afii10057 408 afii10058 409 afii10059 40a afii10060 40b afii10061 40c afii10062 40e afii10065 ' +
  '430 afii10066 431 afii10067 432 afii10068 433 afii10069 434 afii10070 435 afii10071 451 ' +
  'afii10072 436 afii10073 437 afii10074 438 afii10075 439 afii10076 43a afii10077 43b afii10078 ' +
  '43c afii10079 43d afii10080 43e afii10081 43f afii10082 440 afii10083 441 afii10084 442 ' +
  'afii10085 443 afii10086 444 afii10087 445 afii10088 446 afii10089 447 afii10090 448 afii10091 ' +
  '449 afii10092 44a afii10093 44b afii10094 44c afii10095 44d afii10096 44e afii10097 44f ' +
  'afii10098 491 afii10099 452 afii10100 453 afii10101 454 afii10102 455 afii10103 456 afii10104 ' +
  '457 afii10105 458 afii10106 459 afii10107 45a afii10108 45b afii10109 45c afii10110 45e ' +
  'afii10145 40f afii10146 462 afii10147 472 afii10148 474 afii10193 45f afii10194 463 afii10195 ' +
  '473 afii10196 475 afii10846 4d9 afii299 200e afii300 200f afii301 200d afii57636 20aa afii57929 ' +
  '2bc afii61248 2105 afii61289 2113 afii61352 2116 afii61573 202c afii61574 202d afii61575 202e ' +
  'afii61664 200c afii64937 2bd agrave e0 ahookabove 1ea3 aiecyrillic 4d5 ainvertedbreve 203 aleph ' +
  '2135 allequal 224c alpha 3b1 alphatonos 3ac amacron 101 ampersand 26 angle 2220 angleleft 2329 ' +
  'angleright 232a angstrom 212b anoteleia 387 aogonek 105 apostrophearmenian 55a apostrophemod 2bc ' +
  'approaches 2250 approxequal 2248 approxequalorimage 2252 approximatelyequal 2245 arc 2312 ' +
  'arighthalfring 1e9a aring e5 aringacute 1fb aringbelow 1e01 arrowboth 2194 arrowdashdown 21e3 ' +
  'arrowdashleft 21e0 arrowdashright 21e2 arrowdashup 21e1 arrowdblboth 21d4 arrowdbldown 21d3 ' +
  'arrowdblleft 21d0 arrowdblright 21d2 arrowdblup 21d1 arrowdown 2193 arrowdownleft 2199 ' +
  'arrowdownright 2198 arrowdownwhite 21e9 arrowheaddownmod 2c5 arrowheadleftmod 2c2 ' +
  'arrowheadrightmod 2c3 arrowheadupmod 2c4 arrowleft 2190 arrowleftdbl 21d0 arrowleftdblstroke ' +
  '21cd arrowleftoverright 21c6 arrowleftwhite 21e6 arrowright 2192 arrowrightdblstroke 21cf ' +
  'arrowrightoverleft 21c4 arrowrightwhite 21e8 arrowtableft 21e4 arrowtabright 21e5 arrowup 2191 ' +
  'arrowupdn 2195 arrowupdnbse 21a8 arrowupdownbase 21a8 arrowupleft 2196 arrowupleftofdown 21c5 ' +
  'arrowupright 2197 arrowupwhite 21e7 asciicircum 5e asciitilde 7e ascript 251 ascriptturned 252 ' +
  'asterisk 2a asteriskmath 2217 asterism 2042 asymptoticallyequal 2243 at 40 atilde e3 aturned 250 ' +
  'aybarmenian 561 b 62 backslash 5c bar 7c bdotaccent 1e03 bdotbelow 1e05 beamedsixteenthnotes ' +
  '266c because 2235 becyrillic 431 benarmenian 562 beta 3b2 betasymbolgreek 3d0 bhook 253 ' +
  'bilabialclick 298 blackcircle 25cf blackdiamond 25c6 blackdownpointingtriangle 25bc ' +
  'blackleftpointingpointer 25c4 blackleftpointingtriangle 25c0 blacklowerlefttriangle 25e3 ' +
  'blacklowerrighttriangle 25e2 blackrectangle 25ac blackrightpointingpointer 25ba ' +
  'blackrightpointingtriangle 25b6 blacksmallsquare 25aa blacksmilingface 263b blacksquare 25a0 ' +
  'blackstar 2605 blackupperlefttriangle 25e4 blackupperrighttriangle 25e5 ' +
  'blackuppointingsmalltriangle 25b4 blackuppointingtriangle 25b2 blinebelow 1e07 braceleft 7b ' +
  'braceright 7d bracketleft 5b bracketright 5d breve 2d8 brevebelowcmb 32e brevecmb 306 ' +
  'breveinvertedbelowcmb 32f breveinvertedcmb 311 breveinverteddoublecmb 361 bridgebelowcmb 32a ' +
  'bridgeinvertedbelowcmb 33a brokenbar a6 bstroke 180 btopbar 183 bullet 2022 bulletinverse 25d8 ' +
  'bulletoperator 2219 bullseye 25ce c 63 caarmenian 56e cacute 107 candrabinducmb 310 capslock ' +
  '21ea careof 2105 caron 2c7 caronbelowcmb 32c caroncmb 30c carriagereturn 21b5 ccaron 10d ' +
  'ccedilla e7 ccedillaacute 1e09 ccircumflex 109 ccurl 255 cdot 10b cdotaccent 10b cedilla b8 ' +
  'cedillacmb 327 cent a2 centigrade 2103 chaarmenian 579 cheabkhasiancyrillic 4bd checyrillic 447 ' +
  'chedescenderabkhasiancyrillic 4bf chedescendercyrillic 4b7 chedieresiscyrillic 4f5 cheharmenian ' +
  '573 chekhakassiancyrillic 4cc cheverticalstrokecyrillic 4b9 chi 3c7 chook 188 circle 25cb ' +
  'circlecopyrt a9 circlemultiply 2297 circleot 2299 circleplus 2295 circlewithlefthalfblack 25d0 ' +
  'circlewithrighthalfblack 25d1 circumflex 2c6 circumflexbelowcmb 32d circumflexcmb 302 clear 2327 ' +
  'clickalveolar 1c2 clickdental 1c0 clicklateral 1c1 clickretroflex 1c3 club 2663 clubsuitblack ' +
  '2663 clubsuitwhite 2667 coarmenian 581 colon 3a colonmonetary 20a1 colonsign 20a1 ' +
  'colontriangularhalfmod 2d1 colontriangularmod 2d0 comma 2c commaabovecmb 313 commaaboverightcmb ' +
  '315 commaarmenian 55d commareversedabovecmb 314 commareversedmod 2bd commaturnedabovecmb 312 ' +
  'commaturnedmod 2bb compass 263c congruent 2245 contourintegral 222e control 2303 controlACK 6 ' +
  'controlBEL 7 controlBS 8 controlCAN 18 controlCR d controlDC1 11 controlDC2 12 controlDC3 13 ' +
  'controlDC4 14 controlDEL 7f controlDLE 10 controlEM 19 controlENQ 5 controlEOT 4 controlESC 1b ' +
  'controlETB 17 controlETX 3 controlFF c controlFS 1c controlGS 1d controlHT 9 controlLF a ' +
  'controlNAK 15 controlNULL 0 controlRS 1e controlSI f controlSO e controlSOT 2 controlSTX 1 ' +
  'controlSUB 1a controlSYN 16 controlUS 1f controlVT b copyright a9 cruzeiro 20a2 cstretched 297 ' +
  'curlyand 22cf curlyor 22ce currency a4 d 64 daarmenian 564 dagger 2020 daggerdbl 2021 ' +
  'dasiapneumatacyrilliccmb 485 dblarchinvertedbelowcmb 32b dblarrowleft 21d4 dblarrowright 21d2 ' +
  'dblgravecmb 30f dblintegral 222c dbllowline 2017 dbllowlinecmb 333 dbloverlinecmb 33f ' +
  'dblprimemod 2ba dblverticalbar 2016 dblverticallineabovecmb 30e dcaron 10f dcedilla 1e11 ' +
  'dcircumflexbelow 1e13 dcroat 111 ddotaccent 1e0b ddotbelow 1e0d decyrillic 434 degree b0 ' +
  'deicoptic 3ef deleteleft 232b deleteright 2326 delta 3b4 deltaturned 18d dezh 2a4 dhook 257 ' +
  'dialytikatonos 385 dialytikatonoscmb 344 diamond 2666 diamondsuitwhite 2662 dieresis a8 ' +
  'dieresisbelowcmb 324 dieresiscmb 308 dieresistonos 385 divide f7 divides 2223 divisionslash 2215 ' +
  'djecyrillic 452 dlinebelow 1e0f dmacron 111 dollar 24 dong 20ab dotaccent 2d9 dotaccentcmb 307 ' +
  'dotbelowcmb 323 dotbelowcomb 323 dotlessi 131 dotlessjstrokehook 284 dotmath 22c5 dottedcircle ' +
  '25cc downtackbelowcmb 31e downtackmod 2d5 dtail 256 dtopbar 18c dz 1f3 dzaltone 2a3 dzcaron 1c6 ' +
  'dzcurl 2a5 dzeabkhasiancyrillic 4e1 dzecyrillic 455 dzhecyrillic 45f e 65 eacute e9 earth 2641 ' +
  'ebreve 115 ecaron 11b ecedillabreve 1e1d echarmenian 565 echyiwnarmenian 587 ecircumflex ea ' +
  'ecircumflexacute 1ebf ecircumflexbelow 1e19 ecircumflexdotbelow 1ec7 ecircumflexgrave 1ec1 ' +
  'ecircumflexhookabove 1ec3 ecircumflextilde 1ec5 ecyrillic 454 edblgrave 205 edieresis eb edot ' +
  '117 edotaccent 117 edotbelow 1eb9 efcyrillic 444 egrave e8 eharmenian 567 ehookabove 1ebb eight ' +
  '38 eighthnotebeamed 266b eightinferior 2088 eightroman 2177 eightsuperior 2078 einvertedbreve ' +
  '207 eiotifiedcyrillic 465 elcyrillic 43b element 2208 elevenroman 217a ellipsis 2026 ' +
  'ellipsisvertical 22ee emacron 113 emacronacute 1e17 emacrongrave 1e15 emcyrillic 43c emdash 2014 ' +
  'emphasismarkarmenian 55b emptyset 2205 encyrillic 43d endash 2013 endescendercyrillic 4a3 eng ' +
  '14b enghecyrillic 4a5 enhookcyrillic 4c8 enspace 2002 eogonek 119 eopen 25b eopenclosed 29a ' +
  'eopenreversed 25c eopenreversedclosed 25e eopenreversedhook 25d epsilon 3b5 epsilontonos 3ad ' +
  'equal 3d equalsuperior 207c equivalence 2261 ercyrillic 440 ereversed 258 ereversedcyrillic 44d ' +
  'escyrillic 441 esdescendercyrillic 4ab esh 283 eshcurl 286 eshreversedloop 1aa eshsquatreversed ' +
  '285 estimated 212e eta 3b7 etarmenian 568 etatonos 3ae eth f0 etilde 1ebd etildebelow 1e1b ' +
  'eturned 1dd euro 20ac exclam 21 exclamarmenian 55c exclamdbl 203c exclamdown a1 existential 2203 ' +
  'ezh 292 ezhcaron 1ef ezhcurl 293 ezhreversed 1b9 ezhtail 1ba f 66 fahrenheit 2109 fdotaccent ' +
  '1e1f feharmenian 586 feicoptic 3e5 female 2640 ff fb00 f_f fb00 ffi fb03 f_f_i fb03 ffl fb04 ' +
  'f_f_l fb04 fi fb01 f_i fb01 figuredash 2012 filledbox 25a0 filledrect 25ac firsttonechinese 2c9 ' +
  'fisheye 25c9 fitacyrillic 473 five 35 fiveeighths 215d fiveinferior 2085 fiveroman 2174 ' +
  'fivesuperior 2075 fl fb02 f_l fb02 florin 192 forall 2200 four 34 fourinferior 2084 fourroman ' +
  '2173 foursuperior 2074 fourthtonechinese 2cb fraction 2044 franc 20a3 g 67 gacute 1f5 gamma 3b3 ' +
  'gammalatinsmall 263 gammasuperior 2e0 gangiacoptic 3eb gbreve 11f gcaron 1e7 gcedilla 123 ' +
  'gcircumflex 11d gcommaaccent 123 gdot 121 gdotaccent 121 gecyrillic 433 geometricallyequal 2251 ' +
  'germandbls df ghadarmenian 572 ghemiddlehookcyrillic 495 ghestrokecyrillic 493 gheupturncyrillic ' +
  '491 ghook 260 gimarmenian 563 gjecyrillic 453 glottalinvertedstroke 1be glottalstop 294 ' +
  'glottalstopinverted 296 glottalstopmod 2c0 glottalstopreversed 295 glottalstopreversedmod 2c1 ' +
  'glottalstopreversedsuperior 2e4 glottalstopstroke 2a1 glottalstopstrokereversed 2a2 gmacron 1e21 ' +
  'gradient 2207 grave 60 gravebelowcmb 316 gravecmb 300 gravecomb 300 gravelowmod 2ce gravetonecmb ' +
  '340 greater 3e greaterequal 2265 greaterequalorless 22db greaterorequivalent 2273 greaterorless ' +
  '2277 greateroverequal 2267 gscript 261 gstroke 1e5 guillemotleft ab guillemotright bb ' +
  'guilsinglleft 2039 guilsinglright 203a h 68 haabkhasiancyrillic 4a9 hadescendercyrillic 4b3 ' +
  'hardsigncyrillic 44a harpoonleftbarbup 21bc harpoonrightbarbup 21c0 hbar 127 hbrevebelow 1e2b ' +
  'hcedilla 1e29 hcircumflex 125 hdieresis 1e27 hdotaccent 1e23 hdotbelow 1e25 heart 2665 ' +
  'heartsuitblack 2665 heartsuitwhite 2661 henghook 267 hhook 266 hhooksuperior 2b1 hlinebelow 1e96 ' +
  'hoarmenian 570 hookabovecomb 309 hookcmb 309 hookpalatalizedbelowcmb 321 hookretroflexbelowcmb ' +
  '322 horicoptic 3e9 horizontalbar 2015 horncmb 31b hotsprings 2668 house 2302 hsuperior 2b0 ' +
  'hturned 265 hungarumlaut 2dd hungarumlautcmb 30b hv 195 hyphen 2d hyphentwo 2010 i 69 iacute ed ' +
  'iacyrillic 44f ibreve 12d icaron 1d0 icircumflex ee icyrillic 456 idblgrave 209 idieresis ef ' +
  'idieresisacute 1e2f idieresiscyrillic 4e5 idotbelow 1ecb iebrevecyrillic 4d7 iecyrillic 435 ' +
  'igrave ec ihookabove 1ec9 iicyrillic 438 iinvertedbreve 20b iishortcyrillic 439 ij 133 ilde 2dc ' +
  'imacron 12b imacroncyrillic 4e3 imageorapproximatelyequal 2253 increment 2206 infinity 221e ' +
  'iniarmenian 56b integral 222b integralbottom 2321 integralbt 2321 integraltop 2320 integraltp ' +
  '2320 intersection 2229 invbullet 25d8 invcircle 25d9 invsmileface 263b iocyrillic 451 iogonek ' +
  '12f iota 3b9 iotadieresis 3ca iotadieresistonos 390 iotalatin 269 iotatonos 3af istroke 268 ' +
  'itilde 129 itildebelow 1e2d iucyrillic 44e izhitsacyrillic 475 izhitsadblgravecyrillic 477 j 6a ' +
  'jaarmenian 571 jcaron 1f0 jcircumflex 135 jcrossedtail 29d jdotlessstroke 25f jecyrillic 458 ' +
  'jheharmenian 57b jsuperior 2b2 k 6b kabashkircyrillic 4a1 kacute 1e31 kacyrillic 43a ' +
  'kadescendercyrillic 49b kahookcyrillic 4c4 kappa 3ba kappasymbolgreek 3f0 kastrokecyrillic 49f ' +
  'kaverticalstrokecyrillic 49d kcaron 1e9 kcedilla 137 kcommaaccent 137 kdotbelow 1e33 keharmenian ' +
  '584 kenarmenian 56f kgreenlandic 138 khacyrillic 445 kheicoptic 3e7 khook 199 kjecyrillic 45c ' +
  'klinebelow 1e35 koppacyrillic 481 koroniscmb 343 ksicyrillic 46f kturned 29e l 6c lacute 13a ' +
  'lambda 3bb lambdastroke 19b largecircle 25ef lbar 19a lbelt 26c lcaron 13e lcedilla 13c ' +
  'lcircumflexbelow 1e3d lcommaaccent 13c ldot 140 ldotaccent 140 ldotbelow 1e37 ldotbelowmacron ' +
  '1e39 leftangleabovecmb 31a lefttackbelowcmb 318 less 3c lessequal 2264 lessequalorgreater 22da ' +
  'lessorequivalent 2272 lessorgreater 2276 lessoverequal 2266 lezh 26e lhookretroflex 26d lira ' +
  '20a4 liwnarmenian 56c lj 1c9 ljecyrillic 459 llinebelow 1e3b lmiddletilde 26b logicaland 2227 ' +
  'logicalnot ac logicalnotreversed 2310 logicalor 2228 longs 17f lowlinecmb 332 lozenge 25ca ' +
  'lslash 142 lsquare 2113 m 6d macron af macronbelowcmb 331 macroncmb 304 macronlowmod 2cd macute ' +
  '1e3f male 2642 mars 2642 mdotaccent 1e41 mdotbelow 1e43 menarmenian 574 mhook 271 middot b7 ' +
  'minus 2212 minusbelowcmb 320 minuscircle 2296 minusmod 2d7 minusplus 2213 minute 2032 ' +
  'mlonglegturned 270 mturned 26f mu b5 mu1 b5 muchgreater 226b muchless 226a mugreek 3bc multiply ' +
  'd7 musicalnote 266a musicalnotedbl 266b musicflatsign 266d musicsharpsign 266f n 6e nabla 2207 ' +
  'nacute 144 napostrophe 149 nbspace a0 ncaron 148 ncedilla 146 ncircumflexbelow 1e4b ncommaaccent ' +
  '146 ndotaccent 1e45 ndotbelow 1e47 newsheqelsign 20aa nhookleft 272 nhookretroflex 273 nine 39 ' +
  'nineinferior 2089 nineroman 2178 ninesuperior 2079 nj 1cc njecyrillic 45a nlegrightlong 19e ' +
  'nlinebelow 1e49 nonbreakingspace a0 notcontains 220c notelement 2209 notelementof 2209 notequal ' +
  '2260 notgreater 226f notgreaternorequal 2271 notgreaternorless 2279 notidentical 2262 notless ' +
  '226e notlessnorequal 2270 notparallel 2226 notprecedes 2280 notsubset 2284 notsucceeds 2281 ' +
  'notsuperset 2285 nowarmenian 576 nsuperior 207f ntilde f1 nu 3bd numbersign 23 numeralsigngreek ' +
  '374 numeralsignlowergreek 375 numero 2116 o 6f oacute f3 obarred 275 obarredcyrillic 4e9 ' +
  'obarreddieresiscyrillic 4eb obreve 14f ocaron 1d2 ocircumflex f4 ocircumflexacute 1ed1 ' +
  'ocircumflexdotbelow 1ed9 ocircumflexgrave 1ed3 ocircumflexhookabove 1ed5 ocircumflextilde 1ed7 ' +
  'ocyrillic 43e odblacute 151 odblgrave 20d odieresis f6 odieresiscyrillic 4e7 odotbelow 1ecd oe ' +
  '153 ogonek 2db ogonekcmb 328 ograve f2 oharmenian 585 ohookabove 1ecf ohorn 1a1 ohornacute 1edb ' +
  'ohorndotbelow 1ee3 ohorngrave 1edd ohornhookabove 1edf ohorntilde 1ee1 ohungarumlaut 151 oi 1a3 ' +
  'oinvertedbreve 20f omacron 14d omacronacute 1e53 omacrongrave 1e51 omega 3c9 omega1 3d6 ' +
  'omegacyrillic 461 omegalatinclosed 277 omegaroundcyrillic 47b omegatitlocyrillic 47d omegatonos ' +
  '3ce omicron 3bf omicrontonos 3cc one 31 onedotenleader 2024 oneeighth 215b onehalf bd ' +
  'oneinferior 2081 onequarter bc oneroman 2170 onesuperior b9 onethird 2153 oogonek 1eb ' +
  'oogonekmacron 1ed oopen 254 openbullet 25e6 option 2325 ordfeminine aa ordmasculine ba ' +
  'orthogonal 221f oslash f8 oslashacute 1ff ostrokeacute 1ff otcyrillic 47f otilde f5 otildeacute ' +
  '1e4d otildedieresis 1e4f overline 203e overlinecmb 305 overscore af p 70 pacute 1e55 pagedown ' +
  '21df pageup 21de palatalizationcyrilliccmb 484 palochkacyrillic 4c0 paragraph b6 parallel 2225 ' +
  'parenleft 28 parenleftinferior 208d parenleftsuperior 207d parenright 29 parenrightinferior 208e ' +
  'parenrightsuperior 207e partialdiff 2202 pdotaccent 1e57 pecyrillic 43f peharmenian 57a ' +
  'pemiddlehookcyrillic 4a7 percent 25 period 2e periodarmenian 589 periodcentered b7 ' +
  'perispomenigreekcmb 342 perpendicular 22a5 perthousand 2030 peseta 20a7 phi 3c6 phi1 3d5 ' +
  'philatin 278 phisymbolgreek 3d5 phook 1a5 pi 3c0 pisymbolgreek 3d6 piwrarmenian 583 ' +
  'planckover2pi 210f planckover2pi1 210f plus 2b plusbelowcmb 31f pluscircle 2295 plusminus b1 ' +
  'plusmod 2d6 plussuperior 207a pointingindexdownwhite 261f pointingindexleftwhite 261c ' +
  'pointingindexrightwhite 261e pointingindexupwhite 261d precedes 227a prescription 211e primemod ' +
  '2b9 primereversed 2035 product 220f projective 2305 propellor 2318 propersubset 2282 ' +
  'propersuperset 2283 proportion 2237 proportional 221d psi 3c8 psicyrillic 471 ' +
  'psilipneumatacyrilliccmb 486 q 71 qhook 2a0 quarternote 2669 question 3f questionarmenian 55e ' +
  'questiondown bf questiongreek 37e quotedbl 22 quotedblbase 201e quotedblleft 201c quotedblright ' +
  '201d quoteleft 2018 quoteleftreversed 201b quotereversed 201b quoteright 2019 quoterightn 149 ' +
  'quotesinglbase 201a quotesingle 27 r 72 raarmenian 57c racute 155 radical 221a ramshorn 264 ' +
  'ratio 2236 rcaron 159 rcedilla 157 rcommaaccent 157 rdblgrave 211 rdotaccent 1e59 rdotbelow 1e5b ' +
  'rdotbelowmacron 1e5d referencemark 203b reflexsubset 2286 reflexsuperset 2287 registered ae ' +
  'reharmenian 580 reversedtilde 223d revlogicalnot 2310 rfishhook 27e rfishhookreversed 27f rho ' +
  '3c1 rhook 27d rhookturned 27b rhookturnedsuperior 2b5 rhosymbolgreek 3f1 rhotichookmod 2de ' +
  'rightangle 221f righttackbelowcmb 319 righttriangle 22bf ring 2da ringbelowcmb 325 ringcmb 30a ' +
  'ringhalfleft 2bf ringhalfleftarmenian 559 ringhalfleftbelowcmb 31c ringhalfleftcentered 2d3 ' +
  'ringhalfright 2be ringhalfrightbelowcmb 339 ringhalfrightcentered 2d2 rinvertedbreve 213 ' +
  'rlinebelow 1e5f rlongleg 27c rlonglegturned 27a rturned 279 rturnedsuperior 2b4 s 73 sacute 15b ' +
  'sacutedotaccent 1e65 scaron 161 scarondotaccent 1e67 scedilla 15f schwa 259 schwacyrillic 4d9 ' +
  'schwadieresiscyrillic 4db schwahook 25a scircumflex 15d scommaaccent 219 sdotaccent 1e61 ' +
  'sdotbelow 1e63 sdotbelowdotaccent 1e69 seagullbelowcmb 33c second 2033 secondtonechinese 2ca ' +
  'section a7 seharmenian 57d semicolon 3b seven 37 seveneighths 215e seveninferior 2087 sevenroman ' +
  '2176 sevensuperior 2077 sfthyphen ad shaarmenian 577 shacyrillic 448 shchacyrillic 449 ' +
  'sheicoptic 3e3 sheqel 20aa sheqelhebrew 20aa shhacyrillic 4bb shimacoptic 3ed shook 282 sigma ' +
  '3c3 sigma1 3c2 sigmafinal 3c2 sigmalunatesymbolgreek 3f2 similar 223c six 36 sixinferior 2086 ' +
  'sixroman 2175 sixsuperior 2076 slash 2f slong 17f slongdotaccent 1e9b smileface 263a softhyphen ' +
  'ad softsigncyrillic 44c soliduslongoverlaycmb 338 solidusshortoverlaycmb 337 space 20 ' +
  'spacehackarabic 20 spade 2660 spadesuitblack 2660 spadesuitwhite 2664 squarebelowcmb 33b ' +
  'squarediagonalcrosshatchfill 25a9 squarehorizontalfill 25a4 squareorthogonalcrosshatchfill 25a6 ' +
  'squareupperlefttolowerrightfill 25a7 squareupperrighttolowerleftfill 25a8 squareverticalfill ' +
  '25a5 squarewhitewithsmallblack 25a3 sterling a3 strokelongoverlaycmb 336 strokeshortoverlaycmb ' +
  '335 subset 2282 subsetnotequal 228a subsetorequal 2286 succeeds 227b suchthat 220b summation ' +
  '2211 sun 263c superset 2283 supersetnotequal 228b supersetorequal 2287 t 74 tackdown 22a4 ' +
  'tackleft 22a3 tau 3c4 tbar 167 tcaron 165 tccurl 2a8 tcedilla 163 tcircumflexbelow 1e71 ' +
  'tcommaaccent 163 tdieresis 1e97 tdotaccent 1e6b tdotbelow 1e6d tecyrillic 442 ' +
  'tedescendercyrillic 4ad telephone 2121 telephoneblack 260e tenroman 2179 tesh 2a7 tetsecyrillic ' +
  '4b5 thereexists 2203 therefore 2234 theta 3b8 theta1 3d1 thetasymbolgreek 3d1 thook 1ad thorn fe ' +
  'thousandcyrillic 482 three 33 threeeighths 215c threeinferior 2083 threequarters be threeroman ' +
  '2172 threesuperior b3 tilde 2dc tildebelowcmb 330 tildecmb 303 tildecomb 303 tildedoublecmb 360 ' +
  'tildeoperator 223c tildeoverlaycmb 334 tildeverticalcmb 33e timescircle 2297 titlocyrilliccmb ' +
  '483 tiwnarmenian 57f tlinebelow 1e6f toarmenian 569 tonebarextrahighmod 2e5 tonebarextralowmod ' +
  '2e9 tonebarhighmod 2e6 tonebarlowmod 2e8 tonebarmidmod 2e7 tonefive 1bd tonesix 185 tonetwo 1a8 ' +
  'tonos 384 tpalatalhook 1ab trademark 2122 tretroflexhook 288 triagdn 25bc triaglf 25c4 triagrt ' +
  '25ba triagup 25b2 ts 2a6 tsecyrillic 446 tshecyrillic 45b tturned 287 twelveroman 217b two 32 ' +
  'twodotenleader 2025 twodotleader 2025 twoinferior 2082 tworoman 2171 twostroke 1bb twosuperior ' +
  'b2 twothirds 2154 u 75 uacute fa ubar 289 ubreve 16d ucaron 1d4 ucircumflex fb ucircumflexbelow ' +
  '1e77 ucyrillic 443 udblacute 171 udblgrave 215 udieresis fc udieresisacute 1d8 udieresisbelow ' +
  '1e73 udieresiscaron 1da udieresiscyrillic 4f1 udieresisgrave 1dc udieresismacron 1d6 udotbelow ' +
  '1ee5 ugrave f9 uhookabove 1ee7 uhorn 1b0 uhornacute 1ee9 uhorndotbelow 1ef1 uhorngrave 1eeb ' +
  'uhornhookabove 1eed uhorntilde 1eef uhungarumlaut 171 uhungarumlautcyrillic 4f3 uinvertedbreve ' +
  '217 ukcyrillic 479 umacron 16b umacroncyrillic 4ef umacrondieresis 1e7b underscore 5f ' +
  'underscoredbl 2017 union 222a universal 2200 uogonek 173 upsilon 3c5 upsilondieresis 3cb ' +
  'upsilondieresistonos 3b0 upsilonlatin 28a upsilontonos 3cd uptackbelowcmb 31d uptackmod 2d4 ' +
  'uring 16f ushortcyrillic 45e ustraightcyrillic 4af ustraightstrokecyrillic 4b1 utilde 169 ' +
  'utildeacute 1e79 utildebelow 1e75 v 76 vdotbelow 1e7f vecyrillic 432 venus 2640 verticalbar 7c ' +
  'verticallineabovecmb 30d verticallinebelowcmb 329 verticallinelowmod 2cc verticallinemod 2c8 ' +
  'vewarmenian 57e vhook 28b voarmenian 578 vtilde 1e7d vturned 28c w 77 wacute 1e83 wcircumflex ' +
  '175 wdieresis 1e85 wdotaccent 1e87 wdotbelow 1e89 weierstrass 2118 wgrave 1e81 whitebullet 25e6 ' +
  'whitecircle 25cb whitecircleinverse 25d9 whitediamond 25c7 ' +
  'whitediamondcontainingblacksmalldiamond 25c8 whitedownpointingsmalltriangle 25bf ' +
  'whitedownpointingtriangle 25bd whiteleftpointingsmalltriangle 25c3 whiteleftpointingtriangle ' +
  '25c1 whiterightpointingsmalltriangle 25b9 whiterightpointingtriangle 25b7 whitesmallsquare 25ab ' +
  'whitesmilingface 263a whitesquare 25a1 whitestar 2606 whitetelephone 260f ' +
  'whiteuppointingsmalltriangle 25b5 whiteuppointingtriangle 25b3 won 20a9 wring 1e98 wsuperior 2b7 ' +
  'wturned 28d wynn 1bf x 78 xabovecmb 33d xdieresis 1e8d xdotaccent 1e8b xeharmenian 56d xi 3be ' +
  'xsuperior 2e3 y 79 yacute fd yatcyrillic 463 ycircumflex 177 ydieresis ff ydotaccent 1e8f ' +
  'ydotbelow 1ef5 yen a5 yericyrillic 44b yerudieresiscyrillic 4f9 ygrave 1ef3 yhook 1b4 yhookabove ' +
  '1ef7 yiarmenian 575 yicyrillic 457 yinyang 262f yiwnarmenian 582 yotgreek 3f3 ypogegrammeni 37a ' +
  'ypogegrammenigreekcmb 345 yr 1a6 yring 1e99 ysuperior 2b8 ytilde 1ef9 yturned 28e yusbigcyrillic ' +
  '46b yusbigiotifiedcyrillic 46d yuslittlecyrillic 467 yuslittleiotifiedcyrillic 469 z 7a ' +
  'zaarmenian 566 zacute 17a zcaron 17e zcircumflex 1e91 zcurl 291 zdot 17c zdotaccent 17c ' +
  'zdotbelow 1e93 zecyrillic 437 zedescendercyrillic 499 zedieresiscyrillic 4df zero 30 ' +
  'zeroinferior 2080 zerosuperior 2070 zerowidthnonjoiner 200c zerowidthspace 200b zeta 3b6 ' +
  'zhearmenian 56a zhebrevecyrillic 4c2 zhecyrillic 436 zhedescendercyrillic 497 ' +
  'zhedieresiscyrillic 4dd zlinebelow 1e95 zretroflexhook 290 zstroke 1b6 .notdef 0 ' +
  'angbracketleftbig 2329 angbracketleftBig 2329 angbracketleftbigg 2329 angbracketleftBigg 2329 ' +
  'angbracketrightBig 232a angbracketrightbig 232a angbracketrightBigg 232a angbracketrightbigg ' +
  '232a arrowhookleft 21aa arrowhookright 21a9 arrowlefttophalf 21bc arrowleftbothalf 21bd ' +
  'arrownortheast 2197 arrownorthwest 2196 arrowrighttophalf 21c0 arrowrightbothalf 21c1 ' +
  'arrowsoutheast 2198 arrowsouthwest 2199 backslashbig 2216 backslashBig 2216 backslashBigg 2216 ' +
  'backslashbigg 2216 bardbl 2016 braceleftBig 7b braceleftbig 7b braceleftbigg 7b braceleftBigg 7b ' +
  'bracerightBig 7d bracerightbig 7d bracerightbigg 7d bracerightBigg 7d bracketleftbig 5b ' +
  'bracketleftBig 5b bracketleftbigg 5b bracketleftBigg 5b bracketrightBig 5d bracketrightbig 5d ' +
  'bracketrightbigg 5d bracketrightBigg 5d ceilingleftbig 2308 ceilingleftBig 2308 ceilingleftBigg ' +
  '2308 ceilingleftbigg 2308 ceilingrightbig 2309 ceilingrightBig 2309 ceilingrightbigg 2309 ' +
  'ceilingrightBigg 2309 circledotdisplay 2299 circledottext 2299 circlemultiplydisplay 2297 ' +
  'circlemultiplytext 2297 circleplusdisplay 2295 circleplustext 2295 contintegraldisplay 222e ' +
  'contintegraltext 222e coproductdisplay 2210 coproducttext 2210 floorleftBig 230a floorleftbig ' +
  '230a floorleftbigg 230a floorleftBigg 230a floorrightbig 230b floorrightBig 230b floorrightBigg ' +
  '230b floorrightbigg 230b hatwide 302 hatwider 302 hatwidest 302 integraldisplay 222b ' +
  'integraltext 222b intersectiondisplay 22c2 intersectiontext 22c2 logicalanddisplay 2227 ' +
  'logicalandtext 2227 logicalordisplay 2228 logicalortext 2228 parenleftBig 28 parenleftbig 28 ' +
  'parenleftBigg 28 parenleftbigg 28 parenrightBig 29 parenrightbig 29 parenrightBigg 29 ' +
  'parenrightbigg 29 prime 2032 productdisplay 220f producttext 220f radicalbig 221a radicalBig ' +
  '221a radicalBigg 221a radicalbigg 221a radicalbt 221a radicaltp 221a radicalvertex 221a slashbig ' +
  '2f slashBig 2f slashBigg 2f slashbigg 2f summationdisplay 2211 summationtext 2211 tildewide 2dc ' +
  'tildewider 2dc tildewidest 2dc uniondisplay 22c3 unionmultidisplay 228e unionmultitext 228e ' +
  'unionsqdisplay 2294 unionsqtext 2294 uniontext 22c3 vextenddouble 2225 vextendsingle 2223' +
  '';

let glyphMap = null;

/** The Unicode text a glyph name stands for ('' when unknown): 'A', 'Euro', 'uni20B9', 'u1F600', 'f_f', 'a.sc'. */
export function glyphToUnicode(name) {
  if (!glyphMap) {
    glyphMap = new Map();
    const parts = GLYPH_LIST.trim().split(' ');
    for (let i = 0; i + 1 < parts.length; i += 2) glyphMap.set(parts[i], String.fromCodePoint(parseInt(parts[i + 1], 16)));
  }
  if (!name) return '';
  const known = glyphMap.get(name);
  if (known) return known;
  // Variants such as "a.sc" or "one.oldstyle" stand for the same character.
  const base = name.split('.')[0];
  if (base !== name) return glyphToUnicode(base);
  if (name.includes('_')) return name.split('_').map(glyphToUnicode).join('');
  let m = /^uni((?:[0-9A-F]{4})+)$/.exec(name);
  if (m) return m[1].match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join('');
  m = /^u([0-9A-F]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10FFFF ? String.fromCodePoint(cp) : '';
  }
  return '';
}
