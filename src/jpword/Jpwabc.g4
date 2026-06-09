//java -jar ~/Downloads/antlr-4.8-complete.jar  Jpwabc.g4 -Dlanguage=CSharp -package jpword
//java -jar ~/Downloads/antlr-4.8-complete.jar  Jpwabc.g4
//javac *.java -classpath <antlr-runtime-4.8.jar>
// java -cp <antlr-4.8-complete.jar>:.  org.antlr.v4.gui.TestRig Jpwabc Note -gui < ../inp.txt
grammar Jpwabc;



fragment LBRACE : '(' ;

fragment A : [aA]; // match either an 'a' or 'A'
fragment B : [bB];
fragment C : [cC];
fragment D : [dD];
fragment E : [eE];
fragment F : [fF];
fragment G : [gG];
fragment H : [hH];
fragment I : [iI];
fragment J : [jJ];
fragment K : [kK];
fragment L : [lL];
fragment M : [mM];
fragment N : [nN];
fragment O : [oO];
fragment P : [pP];
fragment Q : [qQ];
fragment R : [rR];
fragment S : [sS];
fragment T : [tT];
fragment U : [uU];
fragment V : [vV];
fragment W : [wW];
fragment X : [xX];
fragment Y : [yY];
fragment Z : [zZ];


fragment Pitch : ( ('b'|'#'|'#b')? [0-7] ([,'gd])* ) | ('x' UniChar?) | ( 'X'  (UniChar?));

voice: entry* ;

entry : note 
	| barline 
	| linebreak 
	| text
	| timesig 
	| prelude_beg
	| prelude_end;

note:Note;
barline:Barline;
linebreak:Return;
text:STRING;
timesig:TimeSig;
prelude_beg:Prelude_beg;
prelude_end:Prelude_end;


Prelude_beg: LBRACE ControlOptions? ;
Prelude_end: RBRACE ControlOptions? ;

fragment 
Duration : '-'+ | ('_'+ '.'*) | ('.'* '_'+) | '.'+ ;

Note : SlurStart* ControlOptions? Tuplet? Articulations? Grace? (Pitch | Chord) Duration? ControlOptions? RBRACE*;
fragment SlurStart : '(' | '{('  ((',' Float?)|( '0:0,' Float ',' Integer )) '}' ;
fragment Float : [-+]? DecimalDigit* '.' DecimalDigit+ ;
fragment DecimalDigit    : '0'..'9' ;
fragment Articulations: '{' Articulation (',' Articulation)* '}' ;
fragment Articulation: 'DunYin' | 'BoYin' | 'YanYin' | 'ZhongYin' ;

fragment Grace : '{' Pitch+ '}';

LBRACK : '[' ;
RBRACK : ']' ;

fragment Chord : LBRACK Pitch+ RBRACK ;


fragment House: '[' ( '结束句' | (DecimalDigit+ '.')) ;
Barline: BarlineType ControlOptions? House? ;
fragment BarlineType: '|' | '||' | '|]' | '[|]'  | ':|' | '|:' | ':|:' | '::' ;
fragment ControlType: 'None' | 'UnderlineOnly' | 'Other' | 'All' | 'Connect' | 'Unconnect' ;
fragment Integer:DecimalDigit+ ;
fragment Number:Integer | Float;
fragment ControlOptions : '{C:' Number ParamList?  (',' ControlType)* '}'  | '{C:0,,}' ;
RBRACE : ')' ;
Return: '$' ParamList?;
fragment ParamList : '(' (Value | ',')* RBRACE ;
fragment Value: (T R U E) | ( F A L S E) | Number ;

fragment Tuplet: '{(' [0-9] '}' ;

TimeSig: DecimalDigit+ '/' DecimalDigit+ ControlOptions?;


fragment HEXADECIMALDIGIT : [a-fA-F0-9] ;
fragment UniChar: ('\\x' Hexquad ) | [\u0100-\udbff];
fragment Hexquad : HEXADECIMALDIGIT HEXADECIMALDIGIT HEXADECIMALDIGIT HEXADECIMALDIGIT;

STRING : '"' ( EscapeSequence | ~["\\] )*? '"' ;

fragment
EscapeSequence
	:	'\\' [sbtnfr"'\\]
	|	'\\x' Hexquad
	| '\\0' DecimalDigit DecimalDigit DecimalDigit DecimalDigit
	;

LINE_COMMENT
    :   '//' ~[\r\n]* -> skip
    ;

WS : [ \t\r\n]+ -> skip ; // skip spaces, tabs, newlines

